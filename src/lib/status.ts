import type { CampaignStatus, CreatorStatus } from "@prisma/client";

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

export function parseCampaignStatus(raw: string): CampaignStatus | null {
  return raw in CAMPAIGN_STATUS_LABELS ? (raw as CampaignStatus) : null;
}

/** Visual grouping of statuses, used for pill and dropdown colours. */
export type StatusTone = "neutral" | "primary" | "warning" | "success" | "danger";

export const CREATOR_STATUS_TONES: Record<CreatorStatus, StatusTone> = {
  discovered: "neutral",
  scored: "neutral",
  review_later: "neutral",
  on_hold: "neutral",
  duplicate: "neutral",
  approved: "primary",
  outreach_scheduled: "warning",
  contacted: "warning",
  follow_up_due: "warning",
  negotiating: "warning",
  content_expected: "warning",
  no_reply: "warning",
  replied: "success",
  interested: "success",
  agreed: "success",
  address_collected: "success",
  product_shipped: "success",
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

/** Tinted background with darker text of the same hue. Every pair passes WCAG AA. */
export const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: "bg-surface-2 text-muted-foreground",
  primary: "bg-primary-soft text-primary-text",
  warning: "bg-warning-soft text-warning-text",
  success: "bg-success-soft text-success-text",
  danger: "bg-danger-soft text-danger-text",
};

/** Text in the tone's dark hue, on the page itself. */
export const TONE_TEXT: Record<StatusTone, string> = {
  neutral: "text-muted-foreground",
  primary: "text-primary-text",
  warning: "text-warning-text",
  success: "text-success-text",
  danger: "text-danger-text",
};

/** The small dot that stands for a tone. */
export const TONE_DOT: Record<StatusTone, string> = {
  neutral: "bg-input",
  primary: "bg-primary",
  warning: "bg-warning-text",
  success: "bg-success-text",
  danger: "bg-danger-text",
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
