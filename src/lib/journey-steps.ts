import type { CreatorStatus } from "@prisma/client";
import { CREATOR_STATUS_LABELS } from "@/lib/status";

/**
 * The five steps of a gifting journey as the team thinks of it, so a creator's
 * page shows one bar instead of twenty-six statuses. Every status maps to a
 * step, to "not started", or to a closed outcome.
 */
export const JOURNEY_STEPS: { label: string; statuses: CreatorStatus[] }[] = [
  { label: "Contacted", statuses: ["outreach_scheduled", "contacted", "follow_up_due", "replied", "interested", "negotiating"] },
  { label: "Agreed", statuses: ["agreed", "address_collected"] },
  { label: "Shipped", statuses: ["product_shipped"] },
  { label: "Content due", statuses: ["content_expected"] },
  { label: "Done", statuses: ["content_posted", "completed"] },
];

const NOT_STARTED: ReadonlySet<CreatorStatus> = new Set(["discovered", "scored", "approved", "review_later"]);

export type JourneyPosition =
  | { kind: "not_started" }
  | { kind: "step"; index: number }
  | { kind: "closed"; label: string; paused: boolean };

export function journeyPosition(status: CreatorStatus): JourneyPosition {
  if (NOT_STARTED.has(status)) return { kind: "not_started" };
  const index = JOURNEY_STEPS.findIndex((step) => step.statuses.includes(status));
  if (index >= 0) return { kind: "step", index };
  return { kind: "closed", label: CREATOR_STATUS_LABELS[status], paused: status === "on_hold" };
}
