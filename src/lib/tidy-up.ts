import type { CreatorStatus, Prisma } from "@prisma/client";
import { logActivity } from "@/lib/activity";
import { automationUserId } from "@/lib/automation";
import type { BrandScope } from "@/lib/brand-scope";
import { CSV_IMPORT_MARK, IMPORTED_NOTE } from "@/lib/creator-import";
import { db } from "@/lib/db";
import { openCampaignIn } from "@/lib/due";
import { DAY_MS, formatDay, latestDate } from "@/lib/format";
import { CAMPAIGN_TIMINGS_SELECT, nextActionFor } from "@/lib/next-action";
import { CREATOR_STATUS_LABELS } from "@/lib/status";
import { ASSUMED_DELIVERY_DAYS, MIN_LINK_AGE_DAYS, TIDY_ACTIONS, TIDY_CHUNK, TIDY_DAYS, TIDY_GROUPS, TIDY_NOTE, type TidyAction, type TidyGroupKey } from "@/lib/tidy-up-rules";

/**
 * Admin > Tidy up old work. The old imported sheets left hundreds of
 * conversations that Home shows as due every day (replies from 2025 nobody
 * will answer now, parcels shipped before the portal with no tracking). A
 * person picks how old is "old", sees every creator each choice would touch,
 * and only then applies it. Only creators Home shows as due are offered, and
 * only those nobody has touched since the cut-off (see lastTouches). Every
 * change is recorded with what it was before, so Undo puts it back exactly,
 * unless someone has worked on the creator since. Nothing is deleted and
 * nothing is sent. Each call keeps to a time budget and says what is left.
 */

/** Server calls stop starting new work after this long; the page sends the rest again. */
const BUDGET_MS = 5_000;
/** Lines the import writes (also under the importing person's name); they say when a row was loaded, not that anyone worked on it. */
const IMPORT_KINDS = ["csv_import", "influencer_created", "influencer_updated", "profile_added"];
const NOT_A_TOUCH: Prisma.ActivityWhereInput[] = [{ body: { startsWith: TIDY_NOTE } }, { body: { startsWith: IMPORTED_NOTE } }, { body: { contains: CSV_IMPORT_MARK } }];
/** What the next step and Undo need to know about a creator. */
const CREATOR_FIELDS = {
  id: true,
  status: true,
  influencerId: true,
  nextAction: true,
  nextActionDueAt: true,
  waitingOn: true,
  contentDueAt: true,
  lastContactedAt: true,
  followUpsSent: true,
  selectionSentAt: true,
  reengageAfter: true,
  campaign: { select: CAMPAIGN_TIMINGS_SELECT },
} as const;

type TidyRow = { id: string; name: string; campaign: string; status: CreatorStatus; lastTouch: Date | null; giftIds: string[] };
type GiftWritten = { id: string; deliveredAt: string; trackingStatus: string | null };

const groupOf = (status: CreatorStatus) => TIDY_GROUPS.find((group) => group.statuses.includes(status)) ?? null;

/**
 * The last time someone worked on each creator: a message logged, a reply
 * recorded, anything a person did on their record (a status, a note, a gift
 * approved, files reviewed), or files the creator sent. The import, the
 * automation and the tidy-up itself never count, so the old backlog is seen
 * as untouched and an undone tidy-up can be done again.
 */
async function lastTouches(links: { id: string; lastContactedAt: Date | null; repliedAt: Date | null }[]): Promise<Map<string, Date | null>> {
  const ids = links.map((link) => link.id);
  if (ids.length === 0) return new Map();
  const automation = await automationUserId();
  const [messages, activity] = await Promise.all([
    db.message.groupBy({ by: ["campaignCreatorId"], where: { campaignCreatorId: { in: ids } }, _max: { sentAt: true } }),
    db.activity.groupBy({
      by: ["campaignCreatorId"],
      where: {
        campaignCreatorId: { in: ids },
        OR: [
          { automated: false, userId: { not: automation }, kind: { notIn: IMPORT_KINDS }, NOT: NOT_A_TOUCH },
          // The upload page records files as the automation, but they are the creator's own work.
          { kind: "content_received" },
        ],
      },
      _max: { createdAt: true },
    }),
  ]);
  const sent = new Map(messages.map((row) => [row.campaignCreatorId, row._max.sentAt]));
  const acted = new Map(activity.map((row) => [row.campaignCreatorId, row._max.createdAt]));
  return new Map(links.map((link) => [link.id, latestDate([link.lastContactedAt, link.repliedAt, sent.get(link.id), acted.get(link.id)])]));
}

/**
 * What a tidy-up with this cut-off would touch, group by group: exactly what
 * Home counts as due (an open campaign, a creator not archived, the next
 * step's day has come), in a campaign for at least two weeks, minus anything
 * touched since the cut-off. With ids, only those creators are checked: Apply
 * re-runs this on the ids the preview showed, so it can only ever change what
 * the person saw.
 */
export async function tidyCandidates(scope: BrandScope, days: number, now = new Date(), onlyIds?: string[]): Promise<Map<TidyGroupKey, TidyRow[]>> {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const links = await db.campaignCreator.findMany({
    where: {
      status: { in: TIDY_GROUPS.flatMap((group) => group.statuses) },
      campaign: openCampaignIn(scope),
      influencer: { archived: false },
      nextActionDueAt: { lte: now },
      createdAt: { lt: new Date(now.getTime() - MIN_LINK_AGE_DAYS * DAY_MS) },
      ...(onlyIds ? { id: { in: onlyIds } } : {}),
    },
    select: {
      id: true,
      status: true,
      lastContactedAt: true,
      repliedAt: true,
      nextAction: true,
      influencer: { select: { name: true } },
      campaign: { select: { name: true } },
      giftOrders: { where: { status: { not: "cancelled" } }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, trackingNumber: true, shippedAt: true } },
    },
  });
  const touches = await lastTouches(links);

  const groups = new Map<TidyGroupKey, TidyRow[]>(TIDY_GROUPS.map((group) => [group.key, []]));
  for (const link of links) {
    const group = groupOf(link.status);
    if (!group) continue;
    const lastTouch = touches.get(link.id) ?? null;
    if (lastTouch && lastTouch >= cutoff) continue;
    // Every untracked parcel of the shipment, as long as the newest gift is one of them; a problem or a tracking number is real work.
    const untracked = link.giftOrders.filter((gift) => gift.status === "shipped" && !gift.trackingNumber && gift.shippedAt && gift.shippedAt < cutoff);
    if (group.key === "parcels" && (!link.giftOrders[0] || !untracked.some((gift) => gift.id === link.giftOrders[0].id))) continue;
    // Only those still waiting for the link; a link sent and not used yet is a different story.
    if (group.key === "selection" && link.nextAction !== "Send the product selection link") continue;
    // Files to review or changes to pass on are real work, however old the post.
    if (group.key === "posted" && link.nextAction !== "Check the post and mark completed") continue;
    groups.get(group.key)!.push({ id: link.id, name: link.influencer.name, campaign: link.campaign.name, status: link.status, lastTouch, giftIds: group.key === "parcels" ? untracked.map((gift) => gift.id) : [] });
  }
  for (const rows of groups.values()) rows.sort((a, b) => (a.lastTouch?.getTime() ?? 0) - (b.lastTouch?.getTime() ?? 0) || a.name.localeCompare(b.name));
  return groups;
}

export type ApplyResult = { ok: true; tidyUpId: string | null; changed: number; skipped: number; pending: string[] } | { ok: false; error: string };

/**
 * Applies one choice to (part of) one group. The ids are the ones the preview
 * showed; each is checked again, and one that no longer fits (someone wrote
 * to the creator, the status moved on) is skipped. Each creator's status, next
 * step and the record Undo needs are written together, so a call cut off
 * half-way leaves nothing half-done; ids it did not reach come back in
 * `pending`. The tidy-up record opens with the first real change.
 */
export async function applyTidyChunk(
  input: { scope: BrandScope; userId: string; days: number; group: TidyGroupKey; action: TidyAction; ids: string[]; tidyUpId: string | null },
  now = new Date(),
  budgetMs = BUDGET_MS,
): Promise<ApplyResult> {
  const group = TIDY_GROUPS.find((entry) => entry.key === input.group);
  if (!group) return { ok: false, error: "Unknown group." };
  if (input.action === "leave" || !group.actions.includes(input.action)) return { ok: false, error: "That choice does not fit this group." };
  if (!(TIDY_DAYS as readonly number[]).includes(input.days)) return { ok: false, error: "Choose how old is old." };
  const ids = [...new Set(input.ids.filter((id) => typeof id === "string" && id.length > 0))];
  if (ids.length === 0 || ids.length > TIDY_CHUNK) return { ok: false, error: `Send 1 to ${TIDY_CHUNK} creators at a time.` };
  let batch: string | null = null;
  if (input.tidyUpId) {
    const open = await db.tidyUp.findFirst({ where: { id: input.tidyUpId, userId: input.userId, undoneAt: null }, select: { id: true } });
    if (!open) return { ok: false, error: "That tidy-up is closed. Start again from the preview." };
    batch = open.id;
  }
  const openBatch = async (tx: Prisma.TransactionClient) => (batch ??= (await tx.tidyUp.create({ data: { userId: input.userId, days: input.days }, select: { id: true } })).id);

  const rows = (await tidyCandidates(input.scope, input.days, now, ids)).get(group.key) ?? [];
  const since = (row: TidyRow) => (row.lastTouch ? `no touch since ${formatDay(row.lastTouch)}` : "not touched since it was imported");
  const started = Date.now();
  const changed: string[] = [];
  const pending: string[] = [];

  if (input.action === "delivered") {
    for (const [index, row] of rows.entries()) {
      if (Date.now() - started > budgetMs) {
        pending.push(...rows.slice(index).map((entry) => entry.id));
        break;
      }
      const done = await db.$transaction(async (tx) => {
        const creator = await tx.campaignCreator.findUnique({ where: { id: row.id }, select: CREATOR_FIELDS });
        if (!creator || creator.status !== row.status) return false;
        const gifts = await tx.giftOrder.findMany({ where: { id: { in: row.giftIds }, status: "shipped", trackingNumber: null }, select: { id: true, shippedAt: true, trackingStatus: true } });
        const written: GiftWritten[] = [];
        for (const gift of gifts) {
          if (!gift.shippedAt) continue;
          const deliveredAt = new Date(Math.min(gift.shippedAt.getTime() + ASSUMED_DELIVERY_DAYS * DAY_MS, now.getTime()));
          const updated = await tx.giftOrder.updateMany({ where: { id: gift.id, status: "shipped", trackingNumber: null }, data: { status: "delivered", deliveredAt, trackingStatus: "Delivered" } });
          if (updated.count === 1) written.push({ id: gift.id, deliveredAt: deliveredAt.toISOString(), trackingStatus: gift.trackingStatus });
        }
        if (written.length === 0) return false;
        // What a delivery does anywhere in the portal, but an assumed delivery never starts a content
        // clock that has already run out: the content is due today at the earliest, so the team has
        // the campaign's full no-content wait to chase it.
        const newest = await tx.giftOrder.findFirst({ where: { campaignCreatorId: row.id, status: { not: "cancelled" } }, orderBy: { createdAt: "desc" }, select: { status: true, shippedAt: true, deliveredAt: true } });
        const deliveredAt = newest?.deliveredAt ?? new Date(written[0].deliveredAt);
        const contentDueAt = new Date(Math.max(deliveredAt.getTime() + creator.campaign.contentDueDays * DAY_MS, now.getTime()));
        const next = nextActionFor({ ...creator, status: "content_expected", contentDueAt, gift: newest }, creator.campaign, now);
        await tx.campaignCreator.update({ where: { id: row.id }, data: { status: "content_expected", contentDueAt, nextAction: next.action, nextActionDueAt: next.dueAt, waitingOn: next.waitingOn } });
        await tx.tidyChange.create({
          data: {
            tidyUpId: await openBatch(tx),
            campaignCreatorId: row.id,
            group: group.key,
            fromStatus: creator.status,
            toStatus: "content_expected",
            prevNextAction: creator.nextAction,
            prevNextActionDueAt: creator.nextActionDueAt,
            prevWaitingOn: creator.waitingOn,
            prevContentDueAt: creator.contentDueAt,
            gifts: written,
          },
        });
        await logActivity(tx, {
          userId: input.userId,
          kind: "status_change",
          campaignCreatorId: row.id,
          influencerId: creator.influencerId,
          body: `${TIDY_NOTE}: ${written.length === 1 ? "the parcel is" : `${written.length} parcels are`} taken as delivered ${ASSUMED_DELIVERY_DAYS} days after shipping (no tracking, ${since(row)}); content due ${formatDay(contentDueAt)}; status changed from ${CREATOR_STATUS_LABELS[creator.status]} to ${CREATOR_STATUS_LABELS.content_expected}.`,
        });
        return true;
      });
      if (done) changed.push(row.id);
    }
  } else {
    const to = TIDY_ACTIONS[input.action].status!;
    // One short step per creator, like the parcels: a slow database can only ever stop the run between creators.
    for (const [index, row] of rows.entries()) {
      if (Date.now() - started > budgetMs) {
        pending.push(...rows.slice(index).map((entry) => entry.id));
        break;
      }
      const done = await db.$transaction(async (tx) => {
        const creator = await tx.campaignCreator.findUnique({ where: { id: row.id }, select: CREATOR_FIELDS });
        if (!creator) return false;
        const next = nextActionFor({ ...creator, status: to, gift: null }, creator.campaign, now);
        // Written only while the status is still the one the preview showed.
        const updated = await tx.campaignCreator.updateMany({ where: { id: creator.id, status: row.status }, data: { status: to, nextAction: next.action, nextActionDueAt: next.dueAt, waitingOn: next.waitingOn } });
        if (updated.count === 0) return false;
        await tx.tidyChange.create({
          data: {
            tidyUpId: await openBatch(tx),
            campaignCreatorId: creator.id,
            group: group.key,
            fromStatus: row.status,
            toStatus: to,
            prevNextAction: creator.nextAction,
            prevNextActionDueAt: creator.nextActionDueAt,
            prevWaitingOn: creator.waitingOn,
          },
        });
        await logActivity(tx, {
          userId: input.userId,
          kind: "status_change",
          campaignCreatorId: creator.id,
          influencerId: creator.influencerId,
          body: `${TIDY_NOTE}: status changed from ${CREATOR_STATUS_LABELS[row.status]} to ${CREATOR_STATUS_LABELS[to]} (${since(row)}).`,
        });
        return true;
      });
      if (done) changed.push(row.id);
    }
  }
  return { ok: true, tidyUpId: batch, changed: changed.length, skipped: ids.length - changed.length - pending.length, pending };
}

export type UndoResult = { ok: true; restored: number; kept: number; left: number } | { ok: false; error: string };

/**
 * Puts back what one tidy-up changed, as far as the time budget allows; the
 * page calls again while `left` is above zero. A creator is put back only if
 * nobody has worked on them since the change: the same test the preview uses
 * (a message, a reply, a person's change) plus their status and parcels still
 * as the tidy-up left them. One exception: a parcel creator the automation
 * then closed as No content goes back too, since nobody did anything. The next
 * step comes back exactly as it was, due date and all.
 */
export async function undoTidyUp(input: { tidyUpId: string; userId: string }, now = new Date(), budgetMs = BUDGET_MS): Promise<UndoResult> {
  const tidyUp = await db.tidyUp.findUnique({ where: { id: input.tidyUpId }, select: { id: true, undoneAt: true } });
  if (!tidyUp) return { ok: false, error: "That tidy-up is not available." };
  if (tidyUp.undoneAt) return { ok: false, error: "That tidy-up was already undone." };
  const changes = await db.tidyChange.findMany({
    where: { tidyUpId: tidyUp.id, undoneAt: null },
    take: TIDY_CHUNK,
    select: {
      id: true,
      fromStatus: true,
      toStatus: true,
      prevNextAction: true,
      prevNextActionDueAt: true,
      prevWaitingOn: true,
      prevContentDueAt: true,
      gifts: true,
      createdAt: true,
      campaignCreator: { select: { id: true, influencerId: true, lastContactedAt: true, repliedAt: true } },
    },
  });
  const touches = await lastTouches(changes.map((change) => change.campaignCreator));
  const started = Date.now();
  let restored = 0;
  let kept = 0;
  for (const change of changes) {
    if (Date.now() - started > budgetMs) break;
    const creator = change.campaignCreator;
    const gifts = (change.gifts as GiftWritten[] | null) ?? [];
    const touched = (touches.get(creator.id) ?? new Date(0)) > change.createdAt;
    const putBack = await db.$transaction(async (tx) => {
      const current = await tx.campaignCreator.findUniqueOrThrow({ where: { id: creator.id }, select: { status: true } });
      const giftsNow = await tx.giftOrder.findMany({ where: { id: { in: gifts.map((gift) => gift.id) } }, select: { id: true, status: true, trackingNumber: true, carrier: true, deliveredAt: true } });
      // Parcels still exactly as the tidy-up left them: nobody added tracking or a real delivery date.
      const parcelsAsLeft = gifts.every((gift) => {
        const found = giftsNow.find((row) => row.id === gift.id);
        return found && found.status === "delivered" && !found.trackingNumber && !found.carrier && found.deliveredAt?.toISOString() === gift.deliveredAt;
      });
      const statusAsLeft = current.status === change.toStatus || (gifts.length > 0 && current.status === "no_content");
      await tx.tidyChange.update({ where: { id: change.id }, data: { undoneAt: now } });
      if (touched || !statusAsLeft || !parcelsAsLeft) return false;
      for (const gift of gifts) await tx.giftOrder.update({ where: { id: gift.id }, data: { status: "shipped", deliveredAt: null, trackingStatus: gift.trackingStatus } });
      await tx.campaignCreator.update({
        where: { id: creator.id },
        data: {
          status: change.fromStatus,
          nextAction: change.prevNextAction,
          nextActionDueAt: change.prevNextActionDueAt,
          waitingOn: change.prevWaitingOn,
          ...(gifts.length > 0 ? { contentDueAt: change.prevContentDueAt } : {}),
        },
      });
      await logActivity(tx, {
        userId: input.userId,
        kind: "status_change",
        campaignCreatorId: creator.id,
        influencerId: creator.influencerId,
        body:
          gifts.length > 0
            ? `${TIDY_NOTE} undone: ${gifts.length === 1 ? "the parcel is" : "the parcels are"} back to shipped, not yet delivered, and the status changed from ${CREATOR_STATUS_LABELS[current.status]} back to ${CREATOR_STATUS_LABELS[change.fromStatus]}.`
            : `${TIDY_NOTE} undone: status changed from ${CREATOR_STATUS_LABELS[current.status]} back to ${CREATOR_STATUS_LABELS[change.fromStatus]}.`,
      });
      return true;
    });
    if (putBack) restored += 1;
    else kept += 1;
  }
  const left = await db.tidyChange.count({ where: { tidyUpId: tidyUp.id, undoneAt: null } });
  if (left === 0) await db.tidyUp.update({ where: { id: tidyUp.id }, data: { undoneAt: now, undoneById: input.userId } });
  return { ok: true, restored, kept, left };
}

const DONE_WORDS: Record<TidyGroupKey, string> = {
  replies: "replies parked",
  followups: "follow-ups",
  selection: "said-yes parked",
  first: "first messages parked",
  parcels: "parcels marked delivered",
  posted: "posts marked completed",
};
/** A group's place in the order the page shows the groups. */
const groupOrder = (group: string) => TIDY_GROUPS.findIndex((entry) => entry.key === group);

export type TidyHistoryEntry = { id: string; createdAt: Date; by: string; days: number; changes: number; undone: boolean; summary: string };

/** The latest tidy-ups, for the Undo list on the page. */
export async function tidyHistory(limit = 6): Promise<TidyHistoryEntry[]> {
  const runs = await db.tidyUp.findMany({ orderBy: { createdAt: "desc" }, take: limit, select: { id: true, createdAt: true, days: true, undoneAt: true, user: { select: { name: true } } } });
  if (runs.length === 0) return [];
  const counts = await db.tidyChange.groupBy({ by: ["tidyUpId", "group", "toStatus"], where: { tidyUpId: { in: runs.map((run) => run.id) } }, _count: true });
  return runs.map((run) => {
    const mine = counts.filter((row) => row.tidyUpId === run.id).sort((a, b) => groupOrder(a.group) - groupOrder(b.group) || a.toStatus.localeCompare(b.toStatus));
    const summary = mine
      .map((row) => (row.group === "followups" ? `${row._count} follow-ups ${row.toStatus === "no_reply" ? "closed" : "parked"}` : `${row._count} ${DONE_WORDS[row.group as TidyGroupKey] ?? row.group}`))
      .join(" · ");
    return { id: run.id, createdAt: run.createdAt, by: run.user.name, days: run.days, changes: mine.reduce((sum, row) => sum + row._count, 0), undone: run.undoneAt !== null, summary: summary || "nothing changed" };
  });
}
