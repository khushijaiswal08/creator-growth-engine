import type { CampaignStatus, ContentStatus, CreatorStatus, UsageRights, UsSignal } from "@prisma/client";

// Keyed by the Prisma enum so a new status fails the type check until it is labelled here.
export const CREATOR_STATUS_LABELS: Record<CreatorStatus, string> = {
  discovered: "Discovered",
  scored: "Scored",
  approved: "Approved",
  rejected: "Rejected",
  review_later: "Review later",
  blacklisted: "Blacklisted",
  outreach_scheduled: "Outreach scheduled",
  contacted: "Contacted",
  follow_up_due: "Follow-up due",
  replied: "Replied",
  interested: "Interested",
  not_interested: "Not interested",
  negotiating: "Negotiating",
  agreed: "Agreed",
  address_collected: "Address collected",
  product_shipped: "Product shipped",
  content_expected: "Content expected",
  content_posted: "Content posted",
  completed: "Completed",
  no_content: "No content delivered",
  no_reply: "No reply",
  invalid_contact: "Invalid contact",
  bounced: "Bounced",
  unsubscribed: "Unsubscribed",
  duplicate: "Duplicate",
  on_hold: "On hold",
};

export const CREATOR_STATUSES = Object.keys(CREATOR_STATUS_LABELS) as CreatorStatus[];

/** "Status changed from Replied to Agreed". The outreach and performance reports count moves by this wording, so it must stay exactly as it is. */
export function statusChangeText(from: CreatorStatus, to: CreatorStatus): string {
  return `Status changed from ${CREATOR_STATUS_LABELS[from]} to ${CREATOR_STATUS_LABELS[to]}`;
}

/** Statuses that count as "earlier than contacted": logging a message moves these to contacted. */
export const PRE_CONTACT_STATUSES: ReadonlySet<CreatorStatus> = new Set([
  "discovered",
  "scored",
  "approved",
  "review_later",
  "outreach_scheduled",
]);

/** Creators in these statuses must not be messaged. */
export const SEND_BLOCKED_STATUSES: ReadonlySet<CreatorStatus> = new Set([
  "blacklisted",
  "unsubscribed",
]);

/** The collaboration ended with content: a post is on file or it was marked complete. */
export const DELIVERED_STATUSES: ReadonlySet<CreatorStatus> = new Set(["content_posted", "completed"]);

/** A gift is on its way or has landed, and the content is still awaited. */
export const GIFT_IN_PROGRESS_STATUSES: ReadonlySet<CreatorStatus> = new Set(["address_collected", "product_shipped", "content_expected"]);

/** Statuses that sit in the review queue waiting for a person to decide. */
export const REVIEW_STATUSES: CreatorStatus[] = ["discovered", "scored"];

/**
 * Why the Message button is greyed out for a creator, or null when they may be
 * messaged. Archived wins over the do-not-contact list, which wins over a
 * closed status. The server action still enforces the rule; this only explains it.
 */
export function sendBlockedReason(status: CreatorStatus, suppressed: string | null, archived = false): string | null {
  if (archived) return "This creator is archived.";
  if (suppressed) return `On the do-not-contact list: ${suppressed}`;
  return SEND_BLOCKED_STATUSES.has(status) ? `Marked ${CREATOR_STATUS_LABELS[status]}.` : null;
}

export function parseCreatorStatus(raw: string): CreatorStatus | null {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return key in CREATOR_STATUS_LABELS ? (key as CreatorStatus) : null;
}

export const CAMPAIGN_STATUS_LABELS: Record<CampaignStatus, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  completed: "Completed",
  archived: "Archived",
};

export const CAMPAIGN_STATUSES = Object.keys(CAMPAIGN_STATUS_LABELS) as CampaignStatus[];

export const US_SIGNAL_LABELS: Record<UsSignal, string> = {
  confirmed: "US confirmed",
  likely: "US likely",
  unknown: "US unknown",
  unlikely: "US unlikely",
};
export const US_SIGNALS = Object.keys(US_SIGNAL_LABELS) as UsSignal[];

/**
 * Visual grouping of statuses, used for chips and the Move menu. One meaning
 * per hue across the portal: info (blue) is moving, warning (amber) is waiting
 * on someone, success (green) is done, danger (red) is a problem or a dead end.
 */
export type StatusTone = "neutral" | "primary" | "info" | "warning" | "success" | "danger" | "violet";

export const CREATOR_STATUS_TONES: Record<CreatorStatus, StatusTone> = {
  discovered: "neutral",
  scored: "neutral",
  review_later: "neutral",
  on_hold: "neutral",
  duplicate: "neutral",
  approved: "neutral",
  no_reply: "neutral",
  outreach_scheduled: "warning",
  contacted: "warning",
  follow_up_due: "warning",
  content_expected: "warning",
  replied: "info",
  interested: "violet",
  negotiating: "info",
  agreed: "violet",
  address_collected: "warning",
  product_shipped: "warning",
  content_posted: "success",
  completed: "success",
  rejected: "danger",
  no_content: "danger",
  not_interested: "danger",
  blacklisted: "danger",
  unsubscribed: "danger",
  bounced: "danger",
  invalid_contact: "danger",
};

export const CAMPAIGN_STATUS_TONES: Record<CampaignStatus, StatusTone> = {
  draft: "neutral",
  active: "success",
  paused: "warning",
  completed: "primary",
  archived: "neutral",
};

/** The content library's chips: where a creator's file stands, and what the creator allows us to do with it. */
export const CONTENT_STATUS_TONES: Record<ContentStatus, StatusTone> = { uploading: "warning", received: "warning", approved: "success", changes_requested: "danger" };
export const USAGE_TONES: Record<UsageRights, StatusTone> = { paid: "success", organic: "info", none: "neutral" };

/** Tinted background with darker text of the same hue. Every pair passes WCAG AA. */
export const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: "bg-surface-2 text-accent-text",
  primary: "bg-primary-soft text-primary-text",
  info: "bg-info-soft text-info-text",
  warning: "bg-warning-soft text-warning-text",
  success: "bg-success-soft text-success-text",
  danger: "bg-danger-soft text-danger-text",
  violet: "bg-violet-soft text-violet-text",
};

/** Text in the tone's dark hue, on the page itself. */
export const TONE_TEXT: Record<StatusTone, string> = {
  neutral: "text-muted-foreground",
  primary: "text-primary-text",
  info: "text-info-text",
  warning: "text-warning-text",
  success: "text-success-text",
  danger: "text-danger-text",
  violet: "text-violet-text",
};

/**
 * Where a creator usually goes next from each status. Shown first in the
 * "Move to" menu; every status stays reachable below them. Not a rule: the
 * team may always choose something else.
 */
export const NEXT_STATUS_SUGGESTIONS: Record<CreatorStatus, CreatorStatus[]> = {
  discovered: ["approved", "rejected", "review_later"],
  scored: ["approved", "rejected", "review_later"],
  review_later: ["approved", "rejected"],
  approved: ["contacted", "on_hold"],
  outreach_scheduled: ["contacted", "on_hold"],
  contacted: ["replied", "interested", "no_reply", "not_interested"],
  follow_up_due: ["replied", "interested", "no_reply", "not_interested"],
  replied: ["interested", "agreed", "not_interested"],
  interested: ["agreed", "negotiating", "not_interested"],
  negotiating: ["agreed", "not_interested"],
  agreed: ["address_collected", "product_shipped"],
  address_collected: ["product_shipped"],
  product_shipped: ["content_expected", "content_posted"],
  content_expected: ["content_posted", "no_content"],
  content_posted: ["completed"],
  completed: ["contacted"],
  no_content: ["contacted", "blacklisted"],
  no_reply: ["contacted"],
  not_interested: ["contacted"],
  on_hold: ["contacted", "approved"],
  rejected: ["review_later"],
  blacklisted: [],
  unsubscribed: [],
  bounced: ["invalid_contact"],
  invalid_contact: [],
  duplicate: [],
};
