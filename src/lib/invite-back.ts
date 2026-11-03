import type { CampaignStatus, CreatorStatus, Platform } from "@prisma/client";
import { logActivity } from "@/lib/activity";
import { attributionByInfluencer } from "@/lib/amazon-stats";
import { refreshNextAction } from "@/lib/automation";
import { withinBrand, type BrandScope } from "@/lib/brand-scope";
import { contentCount, contentRate, gradeFromRecord } from "@/lib/creator-card";
import { db, isUniqueViolation } from "@/lib/db";
import { DAY_MS, latestDate } from "@/lib/format";
import { REPEAT_GIFT_DAYS } from "@/lib/gifts";
import { topFollowers } from "@/lib/profile-url";
import { CREATOR_STATUS_LABELS, SEND_BLOCKED_STATUSES } from "@/lib/status";
import { loadSuppressions } from "@/lib/suppression";
import { LATEST_POST_AND_GIFT, trackRecordFor } from "@/lib/track-record";

/**
 * The Invite back list: creators who already delivered content for us and
 * would be worth gifting again. A person picks an open campaign and the
 * creators to invite; they join it as Approved, with a welcome-back first
 * message waiting on Home. Nothing is sent, and nobody joins a campaign,
 * without that person's click. The same rules decide what the list shows
 * and what the button may do, so a forged request cannot invite anyone the
 * screen would not offer.
 */

/** Campaigns a creator can be invited back to: anything not finished or archived. */
export const OPEN_CAMPAIGN_STATUSES: CampaignStatus[] = ["draft", "active", "paused"];

/** Working with us right now: queued for a first message, in a conversation, or waiting on a gift or content. */
const BUSY_STATUSES: ReadonlySet<CreatorStatus> = new Set([
  "approved",
  "outreach_scheduled",
  "contacted",
  "follow_up_due",
  "replied",
  "interested",
  "negotiating",
  "agreed",
  "address_collected",
  "product_shipped",
  "content_expected",
]);

export type InviteBackRow = {
  id: string;
  name: string;
  location: string | null;
  profiles: { id: string; platform: Platform; handle: string; followers: number | null }[];
  followers: number;
  grade: "star" | "good";
  /** Content delivered for the campaign's brand: post links, or collaborations when the links were never recorded. */
  content: number;
  posts: number;
  rate: number | null;
  gifts: number;
  linkOrders: number;
  linkSales: number;
  lastCollaboration: Date | null;
  /** When the gift rules would let a gift go out without a person again; null when that is already so. */
  giftAgainFrom: Date | null;
  /** Why this creator must not be invited (do-not-contact list, blocked). */
  blocked: string | null;
  /** The campaign they are working with us in right now. */
  busyIn: string | null;
  /** Their status in the chosen campaign, when they are already in it. */
  inCampaign: string | null;
  /** None of the three above: the box can be ticked. */
  invitable: boolean;
};

/**
 * Proven creators: a Star or a Good bet on the same grade the Ranking shows.
 * With a campaign chosen, everything is judged inside that campaign's brand
 * only (their work for it, and whether they are busy with it), so a creator
 * who only ever worked with the other brand is never "invited back", and the
 * other brand's figures never reach this one's records. Blocks and the
 * repeat-gift date count every brand, as the gift rules do.
 */
export async function inviteBackList(viewer: BrandScope, campaign: { id: string; brandId: string } | null, now = new Date()): Promise<InviteBackRow[]> {
  const scope = campaign ? withinBrand(viewer, campaign.brandId) : viewer;
  if (!scope) return [];
  const campaignId = campaign?.id ?? null;
  const influencers = await db.influencer.findMany({
    where: { ...scope.influencers, archived: false, campaigns: { some: { ...scope.creators, status: { in: ["content_posted", "completed"] } } } },
    select: {
      id: true,
      name: true,
      email: true,
      location: true,
      amazonTier: true,
      profiles: { select: { id: true, platform: true, handle: true, followers: true }, orderBy: { platform: "asc" } },
      campaigns: {
        where: scope.creators,
        select: {
          campaignId: true,
          status: true,
          campaign: { select: { name: true } },
          ...LATEST_POST_AND_GIFT,
        },
      },
    },
  });
  if (influencers.length === 0) return [];
  const ids = influencers.map((row) => row.id);

  const [records, fromLinks, suppressions, everyLink, latestGifts] = await Promise.all([
    trackRecordFor(ids, scope),
    attributionByInfluencer(scope.creators),
    loadSuppressions(influencers.map((row) => ({ email: row.email, profiles: row.profiles }))),
    // A block in any brand's campaign stops an invite; the screen only says "do not contact".
    db.campaignCreator.findMany({ where: { influencerId: { in: ids }, status: { in: [...SEND_BLOCKED_STATUSES] } }, select: { influencerId: true } }),
    // The repeat-gift rule counts every brand's gifts, so the date shown here does too.
    db.giftOrder.groupBy({ by: ["campaignCreatorId"], where: { status: { not: "cancelled" }, campaignCreator: { influencerId: { in: ids } } }, _max: { createdAt: true } }),
  ]);
  const blockedIds = new Set(everyLink.map((link) => link.influencerId));
  const linkOwners = latestGifts.length
    ? new Map((await db.campaignCreator.findMany({ where: { id: { in: latestGifts.map((row) => row.campaignCreatorId) } }, select: { id: true, influencerId: true } })).map((link) => [link.id, link.influencerId]))
    : new Map<string, string>();
  const lastGiftAnyBrand = new Map<string, Date>();
  for (const row of latestGifts) {
    const influencerId = linkOwners.get(row.campaignCreatorId);
    const at = row._max.createdAt;
    if (!influencerId || !at) continue;
    const known = lastGiftAnyBrand.get(influencerId);
    if (!known || at > known) lastGiftAnyBrand.set(influencerId, at);
  }

  const rows: InviteBackRow[] = [];
  for (const row of influencers) {
    const record = records.get(row.id);
    const followers = topFollowers(row.profiles);
    const lastPost = latestDate(row.campaigns.flatMap((link) => link.posts.map((post) => post.createdAt)));
    const lastGift = latestDate(row.campaigns.flatMap((link) => link.giftOrders.map((gift) => gift.shippedAt ?? gift.createdAt)));
    const stats = { posts: record?.posts ?? 0, delivered: record?.delivered ?? 0, noContent: record?.noContent ?? 0 };
    const grade = gradeFromRecord(record, { followers, lastGiftAt: lastGift, amazonTier: row.amazonTier });
    if (grade !== "star" && grade !== "good") continue;

    const suppressed = suppressions.reasonFor({ email: row.email, profiles: row.profiles });
    const busy = row.campaigns.find((link) => link.campaignId !== campaignId && BUSY_STATUSES.has(link.status));
    const here = campaignId ? row.campaigns.find((link) => link.campaignId === campaignId) : undefined;
    const lastAnyBrand = lastGiftAnyBrand.get(row.id) ?? null;
    const giftAgain = lastAnyBrand ? new Date(lastAnyBrand.getTime() + REPEAT_GIFT_DAYS * DAY_MS) : null;
    const blocked = suppressed ? `On the do-not-contact list: ${suppressed}` : blockedIds.has(row.id) ? "Do not contact." : null;
    rows.push({
      id: row.id,
      name: row.name,
      location: row.location,
      profiles: row.profiles,
      followers,
      grade,
      content: contentCount(stats),
      posts: stats.posts,
      rate: contentRate(stats),
      gifts: record?.gifts ?? 0,
      linkOrders: fromLinks.get(row.id)?.purchases ?? 0,
      linkSales: fromLinks.get(row.id)?.productSales ?? 0,
      lastCollaboration: latestDate([lastPost, lastGift]),
      giftAgainFrom: giftAgain && giftAgain > now ? giftAgain : null,
      blocked,
      busyIn: busy ? `${busy.campaign.name} (${CREATOR_STATUS_LABELS[busy.status]})` : null,
      inCampaign: here ? CREATOR_STATUS_LABELS[here.status] : null,
      invitable: !blocked && !busy && !here,
    });
  }

  // Who can be invited first; then stars, the most content, the most sales from our links, the most recent.
  return rows.sort(
    (a, b) =>
      Number(b.invitable) - Number(a.invitable) ||
      Number(b.grade === "star") - Number(a.grade === "star") ||
      b.content - a.content ||
      b.linkSales - a.linkSales ||
      (b.lastCollaboration?.getTime() ?? 0) - (a.lastCollaboration?.getTime() ?? 0),
  );
}

/** "3 posts" when the post links are on file, "3 collaborations" when only the outcome is, as on the creator card. */
const delivered = (row: InviteBackRow) => {
  const noun = row.posts >= row.content ? "post" : "collaboration";
  return `${row.content} ${noun}${row.content === 1 ? "" : "s"}`;
};

export type InviteResult = { ok: true; campaign: string; invited: number; skipped: { name: string; reason: string }[] } | { ok: false; error: string };

/** A person's click: adds the chosen proven creators to an open campaign as Approved, ready for the welcome-back message. */
export async function inviteBack(input: { campaignId: string; influencerIds: string[]; userId: string; scope: BrandScope }, now = new Date()): Promise<InviteResult> {
  const ids = [...new Set(input.influencerIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return { ok: false, error: "Tick the creators to invite first." };
  if (ids.length > 100) return { ok: false, error: "Invite at most 100 creators at a time." };
  const campaign = await db.campaign.findFirst({ where: { id: input.campaignId, ...input.scope.campaigns }, select: { id: true, name: true, status: true, brandId: true } });
  if (!campaign) return { ok: false, error: "That campaign is not available." };
  if (!OPEN_CAMPAIGN_STATUSES.includes(campaign.status)) return { ok: false, error: `"${campaign.name}" is finished. Choose an open campaign.` };

  // The same list the page showed for this campaign, so the screen and the button always agree.
  const list = new Map((await inviteBackList(input.scope, campaign, now)).map((row) => [row.id, row]));
  const skipped: { name: string; reason: string }[] = [];
  const created: string[] = [];
  for (const id of ids) {
    const row = list.get(id);
    // Not proven, archived, or outside this person's brand: said the same way, so nothing leaks.
    if (!row) {
      skipped.push({ name: "A creator", reason: "not on the Invite back list" });
      continue;
    }
    const reason = row.blocked ?? (row.inCampaign ? `already in this campaign (${row.inCampaign})` : row.busyIn ? `working with us now in ${row.busyIn}` : null);
    if (reason) {
      skipped.push({ name: row.name, reason });
      continue;
    }
    try {
      const link = await db.$transaction(async (tx) => {
        const link = await tx.campaignCreator.create({
          data: { campaignId: campaign.id, influencerId: id, ownerId: input.userId, status: "approved", invitedBackAt: now },
          select: { id: true },
        });
        await logActivity(tx, {
          userId: input.userId,
          kind: "added_to_campaign",
          campaignCreatorId: link.id,
          influencerId: id,
          body: `Invited back to "${campaign.name}" and approved for outreach: ${delivered(row)} delivered${row.rate === null ? "" : `, ${row.rate}% content rate`}.`,
        });
        return link;
      });
      created.push(link.id);
    } catch (error) {
      // Someone added them a moment ago.
      if (isUniqueViolation(error)) skipped.push({ name: row.name, reason: "already in this campaign" });
      else throw error;
    }
  }
  for (const id of created) await refreshNextAction(id, now);
  return { ok: true, campaign: campaign.name, invited: created.length, skipped };
}
