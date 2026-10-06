import { Prisma, type CreatorStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { nextActionFor, TERMINAL_STATUSES, type CampaignTimings, type NextActionInput } from "@/lib/next-action";
import { CREATOR_STATUS_LABELS, CREATOR_STATUSES } from "@/lib/status";

const DAY = 24 * 60 * 60 * 1000;
const AUTOMATION_EMAIL = "automation@system.invalid";

/**
 * The account automatic actions are logged under, so a manager can always
 * tell a person's action from the system's. It has no usable password.
 */
export async function automationUserId(): Promise<string> {
  const existing = await db.user.findUnique({ where: { email: AUTOMATION_EMAIL }, select: { id: true } });
  if (existing) return existing.id;
  const created = await db.user.create({
    data: { name: "Automation", email: AUTOMATION_EMAIL, passwordHash: "!", role: "marketer", isSystem: true },
    select: { id: true },
  });
  return created.id;
}

const creatorSelect = {
  id: true,
  influencerId: true,
  status: true,
  lastContactedAt: true,
  followUpsSent: true,
  selectionSentAt: true,
  contentDueAt: true,
  reengageAfter: true,
  nextAction: true,
  nextActionDueAt: true,
  waitingOn: true,
  campaign: {
    select: {
      followUpAfterDays: true,
      maxFollowUps: true,
      closeAfterDays: true,
      selectionWaitDays: true,
      deliveryWaitDays: true,
      contentReminderDays: true,
      contentDueDays: true,
      noContentAfterDays: true,
    },
  },
  giftOrders: {
    where: { status: { not: "cancelled" } },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { status: true, shippedAt: true, deliveredAt: true },
  },
} satisfies Prisma.CampaignCreatorSelect;

type LoadedCreator = Prisma.CampaignCreatorGetPayload<{ select: typeof creatorSelect }>;

const toInput = (creator: LoadedCreator, status: CreatorStatus = creator.status): NextActionInput => ({
  status,
  lastContactedAt: creator.lastContactedAt,
  followUpsSent: creator.followUpsSent,
  selectionSentAt: creator.selectionSentAt,
  contentDueAt: creator.contentDueAt,
  reengageAfter: creator.reengageAfter,
  gift: creator.giftOrders[0] ?? null,
});

/**
 * Recomputes the next action for one creator. Every action that changes a
 * creator calls this, so the work queue is right without waiting for the
 * daily run.
 */
export async function refreshNextAction(campaignCreatorId: string, now = new Date()): Promise<void> {
  const creator = await db.campaignCreator.findUnique({ where: { id: campaignCreatorId }, select: creatorSelect });
  if (!creator) return;
  const next = nextActionFor(toInput(creator), creator.campaign, now);
  // A task that is already waiting on us keeps its original due time.
  const dueAt =
    next.waitingOn === "team" && next.action === creator.nextAction && creator.nextActionDueAt
      ? creator.nextActionDueAt
      : next.dueAt;
  await db.campaignCreator.update({
    where: { id: campaignCreatorId },
    data: { nextAction: next.action, nextActionDueAt: dueAt, waitingOn: next.waitingOn },
  });
}

export type AutomationSummary = {
  checked: number;
  followUpsDue: number;
  closedNoReply: number;
  closedNoContent: number;
  nextActionsUpdated: number;
};

/**
 * The daily run. It only does three things to a creator's status, all timers:
 *
 *   Contacted, no reply after the campaign's wait  -> Follow-up due
 *   Contacted, all follow-ups sent and still quiet -> No reply
 *   Content expected, due date long passed         -> No content delivered
 *
 * It never contacts anyone and never approves anything. Then it refreshes the
 * next action of every open creator. Safe to run as often as you like.
 *
 * Creators with no "last contacted" date (imported from the old sheet) are
 * left where they are: the portal does not know when they were messaged.
 */
export async function runAutomations(trigger: "cron" | "manual" | "dashboard", now = new Date()): Promise<AutomationSummary> {
  const run = await db.automationRun.create({ data: { trigger, startedAt: now } });
  const actor = await automationUserId();

  const open = CREATOR_STATUSES.filter((status) => !TERMINAL_STATUSES.has(status));
  const creators = await db.campaignCreator.findMany({
    where: { status: { in: open }, campaign: { status: { not: "archived" } }, influencer: { archived: false } },
    select: creatorSelect,
  });

  const toFollowUp: LoadedCreator[] = [];
  const toClose: LoadedCreator[] = [];
  const toNoContent: LoadedCreator[] = [];
  const newStatus = new Map<string, CreatorStatus>();

  for (const creator of creators) {
    const timings: CampaignTimings = creator.campaign;
    // The product arrived, the content date passed, and the grace period after it has run out too.
    // The record then says so, so the team sees who takes gifts without posting before gifting again.
    if (creator.status === "content_expected") {
      if (creator.contentDueAt && now.getTime() - creator.contentDueAt.getTime() >= timings.noContentAfterDays * DAY) {
        toNoContent.push(creator);
        newStatus.set(creator.id, "no_content");
      }
      continue;
    }
    if (creator.status !== "contacted" || !creator.lastContactedAt) continue;
    const quietFor = now.getTime() - creator.lastContactedAt.getTime();
    if (creator.followUpsSent < timings.maxFollowUps) {
      if (quietFor >= timings.followUpAfterDays * DAY) {
        toFollowUp.push(creator);
        newStatus.set(creator.id, "follow_up_due");
      }
    } else if (quietFor >= timings.closeAfterDays * DAY) {
      toClose.push(creator);
      newStatus.set(creator.id, "no_reply");
    }
  }

  const transition = async (group: LoadedCreator[], from: CreatorStatus, status: CreatorStatus, reason: string) => {
    if (group.length === 0) return;
    await db.$transaction([
      // Guarded on the old status, so a creator a person just moved is left alone.
      db.campaignCreator.updateMany({ where: { id: { in: group.map((c) => c.id) }, status: from }, data: { status } }),
      db.activity.createMany({
        data: group.map((creator) => ({
          userId: actor,
          automated: true,
          campaignCreatorId: creator.id,
          influencerId: creator.influencerId,
          kind: "status_change",
          body: `Status changed from ${CREATOR_STATUS_LABELS[from]} to ${CREATOR_STATUS_LABELS[status]} automatically: ${reason}`,
        })),
      }),
    ]);
  };
  await transition(toFollowUp, "contacted", "follow_up_due", "no reply since the last message.");
  await transition(toClose, "contacted", "no_reply", "no reply after the final follow-up.");
  await transition(toNoContent, "content_expected", "no_content", "the content never came, long after it was due.");

  // Next action for everyone still open, written in bulk and only where it changed.
  const changes: { id: string; action: string | null; dueAt: Date | null; waitingOn: string | null }[] = [];
  for (const creator of creators) {
    const status = newStatus.get(creator.id) ?? creator.status;
    const next = nextActionFor(toInput(creator, status), creator.campaign, now);
    // "Due now" items keep their original due time, so the queue shows how long they have waited.
    const dueAt =
      next.waitingOn === "team" && next.action === creator.nextAction && creator.nextActionDueAt
        ? creator.nextActionDueAt
        : next.dueAt;
    if (
      next.action !== creator.nextAction ||
      next.waitingOn !== creator.waitingOn ||
      (dueAt?.getTime() ?? null) !== (creator.nextActionDueAt?.getTime() ?? null)
    ) {
      changes.push({ id: creator.id, action: next.action, dueAt, waitingOn: next.waitingOn });
    }
  }
  // Dates are stored as UTC without a zone, so the value is converted explicitly: a bare
  // ::timestamp cast would use the database session's time zone.
  for (let start = 0; start < changes.length; start += 400) {
    const rows = changes
      .slice(start, start + 400)
      .map((c) => Prisma.sql`(${c.id}::text, ${c.action}::text, (${c.dueAt}::timestamptz AT TIME ZONE 'UTC'), ${c.waitingOn}::text)`);
    await db.$executeRaw`
      UPDATE "CampaignCreator" AS c
      SET "nextAction" = v.action, "nextActionDueAt" = v.due, "waitingOn" = v.waiting
      FROM (VALUES ${Prisma.join(rows)}) AS v(id, action, due, waiting)
      WHERE c.id = v.id`;
  }

  const summary: AutomationSummary = {
    checked: creators.length,
    followUpsDue: toFollowUp.length,
    closedNoReply: toClose.length,
    closedNoContent: toNoContent.length,
    nextActionsUpdated: changes.length,
  };
  await db.automationRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), summary } });
  return summary;
}

const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * Runs the automation if it has not run in the last 6 hours. The dashboard
 * calls this, so things keep moving even where no scheduler is set up.
 */
export async function runAutomationsIfStale(now = new Date()): Promise<void> {
  const last = await db.automationRun.findFirst({ orderBy: { startedAt: "desc" }, select: { startedAt: true } });
  if (last && now.getTime() - last.startedAt.getTime() < STALE_AFTER_MS) return;
  try {
    await runAutomations("dashboard", now);
  } catch (error) {
    console.error("Automation run failed", error);
  }
}
