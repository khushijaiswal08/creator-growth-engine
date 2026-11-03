import type { CreatorStatus, GiftOrderStatus, TemplatePurpose } from "@prisma/client";
import { DAY_MS } from "@/lib/format";

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
  /** After delivery: ask whether everything arrived as expected. */
  arrivalCheckDays: number;
  selectionWaitDays: number;
  deliveryWaitDays: number;
  contentReminderDays: number;
  contentDueDays: number;
  /** After content was due and still nothing came: closed as "No content delivered". */
  noContentAfterDays: number;
};

/** Each timer: the column it is stored in, how the settings form labels it, and the whole-number range the server accepts. In the order the form shows them. */
export const TIMING_FIELDS: readonly { name: keyof CampaignTimings; label: string; min: number; max: number }[] = [
  { name: "followUpAfterDays", label: "Days without a reply before a follow-up is due", min: 1, max: 60 },
  { name: "maxFollowUps", label: "Follow-ups before giving up", min: 0, max: 5 },
  { name: "closeAfterDays", label: "Days after the last follow-up before closing as No reply", min: 1, max: 90 },
  { name: "selectionWaitDays", label: "Days to wait for a product choice before nudging", min: 1, max: 60 },
  { name: "deliveryWaitDays", label: "Days after shipping before checking on delivery", min: 1, max: 60 },
  { name: "arrivalCheckDays", label: "Days after delivery before asking whether everything arrived", min: 0, max: 30 },
  { name: "contentReminderDays", label: "Days after delivery before a content reminder", min: 1, max: 90 },
  { name: "contentDueDays", label: "Days after delivery before content is overdue", min: 1, max: 180 },
  { name: "noContentAfterDays", label: "Days overdue before closing as No content delivered", min: 1, max: 365 },
];

/** The campaign columns to select so a creator's next step can be worked out: one per CampaignTimings field. */
export const CAMPAIGN_TIMINGS_SELECT = {
  followUpAfterDays: true,
  maxFollowUps: true,
  closeAfterDays: true,
  arrivalCheckDays: true,
  selectionWaitDays: true,
  deliveryWaitDays: true,
  contentReminderDays: true,
  contentDueDays: true,
  noContentAfterDays: true,
} as const satisfies Record<keyof CampaignTimings, true>;

export type NextActionInput = {
  status: CreatorStatus;
  lastContactedAt: Date | null;
  followUpsSent: number;
  selectionSentAt: Date | null;
  contentDueAt: Date | null;
  reengageAfter: Date | null;
  /** The creator's latest gift order that was not cancelled. */
  gift: { status: GiftOrderStatus; shippedAt: Date | null; deliveredAt: Date | null } | null;
  /** Files the creator sent through their upload link that nobody has looked at yet. */
  filesToReview?: number;
  /** When someone last asked for changes to one of the creator's files, if any file is waiting on changes. */
  changesAskedAt?: Date | null;
  /** A proven creator a person invited back: the first message is a welcome back, not a cold introduction. */
  invitedBack?: boolean;
};

export type NextAction = {
  action: string | null;
  /** When someone on the team should look at this creator. */
  dueAt: Date | null;
  /** "team": we owe the next step. "creator": we are waiting, and dueAt is when to chase. */
  waitingOn: "team" | "creator" | null;
};

const none: NextAction = { action: null, dueAt: null, waitingOn: null };
const plus = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS);

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
      return { action: input.invitedBack ? "Send the welcome-back message" : "Send the first message", dueAt: now, waitingOn: "team" };

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
      const overdueAt = input.contentDueAt;
      if (!delivered) {
        if (overdueAt && now >= overdueAt) return { action: "Content is overdue: chase the creator", dueAt: overdueAt, waitingOn: "team" };
        return { action: "Waiting for content", dueAt: overdueAt, waitingOn: "creator" };
      }
      // After delivery, a fixed sequence of touches. The latest touch whose day has come is the
      // one that is due, until a message is logged after that day; then the next touch waits for
      // its own day. Once every touch is done, the no-content timer takes over.
      const steps = deliverySteps(delivered, timings);
      const sent = input.lastContactedAt;
      const reached = steps.filter((step) => now >= step.at);
      const upcoming = steps.find((step) => now < step.at) ?? null;
      const current = reached[reached.length - 1] ?? null;
      if (current && (!sent || sent < current.at)) return { action: current.action, dueAt: current.at, waitingOn: "team" };
      return { action: "Waiting for content", dueAt: upcoming?.at ?? null, waitingOn: "creator" };
    }

    case "content_posted":
      if (input.filesToReview) return { action: "Review the creator's files", dueAt: now, waitingOn: "team" };
      // Changes were asked for in the library, and nobody has written to the creator since.
      if (input.changesAskedAt && (!input.lastContactedAt || input.lastContactedAt < input.changesAskedAt)) {
        return { action: "Tell the creator what to change", dueAt: input.changesAskedAt, waitingOn: "team" };
      }
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

type DeliveryStep = { action: string; at: Date; purpose: TemplatePurpose };

/** The four touches after a parcel arrives, in order; the day of each comes from the campaign's timers. */
const DELIVERY_TOUCHES: { action: string; purpose: TemplatePurpose; daysAfter: (timings: CampaignTimings) => number }[] = [
  { action: "Send the delivery note", purpose: "delivered", daysAfter: () => 0 },
  { action: "Ask whether everything arrived", purpose: "arrival", daysAfter: (t) => t.arrivalCheckDays },
  { action: "Send a content reminder", purpose: "reminder", daysAfter: (t) => t.contentReminderDays },
  { action: "Check the agreed posting date", purpose: "deadline", daysAfter: (t) => t.contentDueDays },
];

/**
 * The touches after a parcel arrives, in order: the delivery note the same
 * day, the arrival check a few days later, the content reminder, then the
 * agreed posting date. Days come from the campaign's timers.
 */
export function deliverySteps(deliveredAt: Date, timings: CampaignTimings): DeliveryStep[] {
  return DELIVERY_TOUCHES.map((touch) => {
    const days = touch.daysAfter(timings);
    return { action: touch.action, at: days === 0 ? deliveredAt : plus(deliveredAt, days), purpose: touch.purpose };
  }).sort((a, b) => a.at.getTime() - b.at.getTime());
}

const ACTION_TEMPLATES: Record<string, TemplatePurpose> = {
  ...Object.fromEntries(DELIVERY_TOUCHES.map((touch) => [touch.action, touch.purpose])),
  "Content is overdue: chase the creator": "reminder",
  "Send the product selection link": "selection",
  "Send the first message": "first",
  "Send the welcome-back message": "welcome_back",
  "Tell the creator what to change": "upload",
};

/** The message template that fits the next action, so the composer opens on the right one. */
export function suggestedTemplate(status: CreatorStatus, action: string | null): TemplatePurpose | null {
  if (action && ACTION_TEMPLATES[action]) return ACTION_TEMPLATES[action];
  if (action?.startsWith("Send follow-up")) return "followup";
  if (status === "agreed") return "agreed";
  return null;
}
