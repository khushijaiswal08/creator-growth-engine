import type { CreatorStatus } from "@prisma/client";

/**
 * The choices on Admin > Tidy up old work, shared by the page and the
 * server. Pure: no database here, so the browser can use it too.
 */

/** Parcels with no tracking are taken to have arrived this long after shipping. */
export const ASSUMED_DELIVERY_DAYS = 7;

/**
 * Every activity line a tidy-up or its undo writes starts with this. Such lines
 * never count as someone working on a creator, and the reports leave them out.
 */
export const TIDY_NOTE = "Tidy-up";

export type TidyAction = "park" | "close" | "complete" | "delivered" | "leave";

export const TIDY_ACTIONS: Record<TidyAction, { label: string; status: CreatorStatus | null }> = {
  park: { label: "Park them (On hold)", status: "on_hold" },
  close: { label: "Close as No reply", status: "no_reply" },
  complete: { label: "Mark completed", status: "completed" },
  delivered: { label: `Mark delivered, ${ASSUMED_DELIVERY_DAYS} days after shipping`, status: "content_expected" },
  leave: { label: "Leave as they are", status: null },
};

export type TidyGroupKey = "replies" | "followups" | "selection" | "first" | "parcels" | "posted";

/** One card on the page each. The first action is the one the page starts on. */
export const TIDY_GROUPS: { key: TidyGroupKey; title: string; about: string; statuses: CreatorStatus[]; actions: TidyAction[] }[] = [
  { key: "replies", title: "Replies nobody answered", about: "The creator wrote back and nothing has happened since.", statuses: ["replied", "negotiating"], actions: ["park", "leave"] },
  { key: "followups", title: "Follow-ups never sent", about: "We messaged, they did not answer, and the follow-up never went.", statuses: ["follow_up_due"], actions: ["close", "park", "leave"] },
  { key: "selection", title: "Said yes, never got the product link", about: "Interested or agreed, but the selection link was never sent.", statuses: ["interested", "agreed"], actions: ["park", "leave"] },
  { key: "first", title: "First messages never sent", about: "Approved for outreach and never messaged.", statuses: ["approved", "outreach_scheduled"], actions: ["park", "leave"] },
  {
    key: "parcels",
    title: "Parcels shipped with no tracking",
    about: "Shipped before the portal or without a tracking number, so Home keeps asking whether they arrived. Marked delivered, the creators move to Content to chase.",
    statuses: ["product_shipped"],
    actions: ["delivered", "leave"],
  },
  { key: "posted", title: "Posts never checked", about: "Marked posted and waiting for someone to check the post.", statuses: ["content_posted"], actions: ["complete", "leave"] },
];

/** "Not touched for" choices on the page, in days. The smallest is also the youngest a creator's place in a campaign may be, so a fresh import or a creator added this week is never offered. */
export const TIDY_DAYS = [14, 21, 30, 60, 90] as const;
export const DEFAULT_TIDY_DAYS = 30;
export const MIN_LINK_AGE_DAYS = TIDY_DAYS[0];

/** At most this many creators per Apply or Undo call; the page sends the rest in further calls. */
export const TIDY_CHUNK = 100;

