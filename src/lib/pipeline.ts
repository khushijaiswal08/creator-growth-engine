import type { CreatorStatus } from "@prisma/client";

/**
 * The campaign board: five lanes the team thinks in, instead of twenty-six
 * statuses. Every status belongs to one lane or is a closed outcome shown as a
 * count under Done. Dropping a card on a lane moves the creator to that lane's
 * entry status; the finer statuses are still set from the creator's page.
 */
export type Lane = { key: string; label: string; color: string; statuses: CreatorStatus[]; dropTo: CreatorStatus };

export const LANES: Lane[] = [
  { key: "to_contact", label: "To contact", color: "#9ca3af", statuses: ["discovered", "scored", "review_later", "approved", "outreach_scheduled", "on_hold"], dropTo: "approved" },
  { key: "conversation", label: "In conversation", color: "#2563eb", statuses: ["contacted", "follow_up_due", "replied", "interested", "negotiating"], dropTo: "contacted" },
  { key: "gifting", label: "Gifting", color: "#d97706", statuses: ["agreed", "address_collected", "product_shipped"], dropTo: "agreed" },
  { key: "content", label: "Content due", color: "#b45309", statuses: ["content_expected"], dropTo: "content_expected" },
  { key: "done", label: "Done", color: "#16a34a", statuses: ["content_posted", "completed"], dropTo: "completed" },
];

/** Outcomes that end a journey without content. Counted under Done, never dragged. */
export const CLOSED_STATUSES: CreatorStatus[] = ["no_content", "no_reply", "not_interested", "rejected", "blacklisted", "unsubscribed", "bounced", "invalid_contact", "duplicate"];

export function laneOf(status: CreatorStatus): Lane | null {
  return LANES.find((lane) => lane.statuses.includes(status)) ?? null;
}
