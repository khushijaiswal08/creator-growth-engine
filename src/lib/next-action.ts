import type { CreatorStatus, GiftOrderStatus } from "@prisma/client";

const DAY = 24 * 60 * 60 * 1000;

/** Statuses where nothing more is expected. Everything else must have a next action. */
export const TERMINAL_STATUSES: ReadonlySet<CreatorStatus> = new Set([
  "completed",
  "no_content",
  "rejected",
  "not_interested",
  "no_reply",
  "blacklisted",
  "unsubscribed",
  "bounced",
  "invalid_contact",
  "duplicate",
]);

export type CampaignTimings = {
  followUpAfterDays: number;
  maxFollowUps: number;
  closeAfterDays: number;
  selectionWaitDays: number;
  deliveryWaitDays: number;
  contentReminderDays: number;
  contentDueDays: number;
  /** After content was due and still nothing came: closed as "No content delivered". */
  noContentAfterDays: number;
};

export type NextActionInput = {
  status: CreatorStatus;
  lastContactedAt: Date | null;
  followUpsSent: number;
  selectionSentAt: Date | null;
  contentDueAt: Date | null;
  reengageAfter: Date | null;
  /** The creator's latest gift order that was not cancelled. */
  gift: { status: GiftOrderStatus; shippedAt: Date | null; deliveredAt: Date | null } | null;
};

export type NextAction = {
  action: string | null;
  /** When someone on the team should look at this creator. */
  dueAt: Date | null;
  /** "team": we owe the next step. "creator": we are waiting, and dueAt is when to chase. */
  waitingOn: "team" | "creator" | null;
};

const none: NextAction = { action: null, dueAt: null, waitingOn: null };
const plus = (date: Date, days: number) => new Date(date.getTime() + days * DAY);

/**
 * The single place that decides what happens next for a creator. Pure: the
 * same inputs always give the same answer, so it is safe to re-run any time.
 */
export function nextActionFor(input: NextActionInput, timings: CampaignTimings, now: Date): NextAction {
  const { status, gift } = input;
  if (TERMINAL_STATUSES.has(status)) return none;

  switch (status) {
    case "discovered":
    case "scored":
      return { action: "Review in the queue", dueAt: now, waitingOn: "team" };

    case "approved":
    case "outreach_scheduled":
      return { action: "Send the first message", dueAt: now, waitingOn: "team" };

    case "contacted":
      return input.lastContactedAt
        ? {
            action: "Waiting for a reply",
            dueAt: plus(input.lastContactedAt, timings.followUpAfterDays),
            waitingOn: "creator",
          }
        : { action: "Waiting for a reply", dueAt: null, waitingOn: "creator" };

    case "follow_up_due":
      return { action: `Send follow-up ${input.followUpsSent + 1}`, dueAt: now, waitingOn: "team" };

    case "replied":
      return { action: "Answer the creator", dueAt: now, waitingOn: "team" };

    case "negotiating":
      return { action: "Decide on the fee and reply", dueAt: now, waitingOn: "team" };

    case "interested":
    case "agreed":
      if (!input.selectionSentAt) return { action: "Send the product selection link", dueAt: now, waitingOn: "team" };
      return {
        action: "Waiting for the creator to choose a product",
        dueAt: plus(input.selectionSentAt, timings.selectionWaitDays),
        waitingOn: "creator",
      };

    case "address_collected":
      if (gift?.status === "needs_approval") return { action: "Approve the gift order", dueAt: now, waitingOn: "team" };
      if (gift?.status === "approved") return { action: "Place the Amazon order", dueAt: now, waitingOn: "team" };
      if (gift?.status === "ordered") return { action: "Add the tracking number", dueAt: now, waitingOn: "team" };
      if (gift?.status === "exception") return { action: "Fix the shipping problem", dueAt: now, waitingOn: "team" };
      return { action: "Create the gift order", dueAt: now, waitingOn: "team" };

    case "product_shipped":
      if (gift?.status === "exception") return { action: "Fix the shipping problem", dueAt: now, waitingOn: "team" };
      return {
        action: "Waiting for delivery",
        dueAt: gift?.shippedAt ? plus(gift.shippedAt, timings.deliveryWaitDays) : null,
        waitingOn: "creator",
      };

    case "content_expected": {
      const delivered = gift?.deliveredAt ?? null;
      const reminderAt = delivered ? plus(delivered, timings.contentReminderDays) : null;
      const overdueAt = input.contentDueAt;
      if (overdueAt && now >= overdueAt) return { action: "Content is overdue: chase the creator", dueAt: overdueAt, waitingOn: "team" };
      if (reminderAt && now >= reminderAt) return { action: "Send a content reminder", dueAt: reminderAt, waitingOn: "team" };
      return { action: "Waiting for content", dueAt: reminderAt ?? overdueAt, waitingOn: "creator" };
    }

    case "content_posted":
      return { action: "Check the post and mark completed", dueAt: now, waitingOn: "team" };

    case "review_later":
    case "on_hold":
      return input.reengageAfter
        ? { action: "Re-engage", dueAt: input.reengageAfter, waitingOn: "creator" }
        : { action: "On hold: decide when to re-engage", dueAt: null, waitingOn: "team" };

    default:
      return none;
  }
}

/** True when the item belongs in today's work queue. */
export function isDue(next: { nextActionDueAt: Date | null }, now: Date): boolean {
  return next.nextActionDueAt !== null && next.nextActionDueAt <= now;
}
