import type { CreatorStatus, Prisma } from "@prisma/client";
import type { BrandScope } from "@/lib/brand-scope";

/**
 * What needs a person today, most urgent first. A creator appears in one
 * group only. Shared by the home page (the task list) and the shell (the
 * count on the bell), so both always agree.
 */
export const QUEUES: { key: string; title: string; statuses: CreatorStatus[]; message: boolean }[] = [
  { key: "replies", title: "Reply today", statuses: ["replied", "negotiating"], message: true },
  { key: "selection", title: "Send the product link", statuses: ["interested", "agreed"], message: true },
  { key: "followups", title: "Follow-ups due", statuses: ["follow_up_due"], message: true },
  { key: "first", title: "First messages", statuses: ["approved", "outreach_scheduled"], message: true },
  { key: "gifts", title: "Gifts needing you", statuses: ["address_collected"], message: false },
  { key: "delivery", title: "Parcels to check", statuses: ["product_shipped"], message: false },
  { key: "content", title: "Content to chase", statuses: ["content_expected"], message: true },
  { key: "posted", title: "Posts to check", statuses: ["content_posted"], message: false },
  { key: "review", title: "To review", statuses: ["discovered", "scored"], message: false },
];

export const DUE_STATUSES: CreatorStatus[] = QUEUES.flatMap((queue) => queue.statuses);

/** Campaigns still being worked, within what the person sees. */
export function openCampaignIn(view: BrandScope): Prisma.CampaignWhereInput {
  return { status: { not: "archived" }, ...view.campaigns };
}

/** "Due" means a person owes the next step now: it is waiting on the team, or the wait for the creator has run out. */
export function dueWhere(view: BrandScope, statuses: CreatorStatus[], now: Date): Prisma.CampaignCreatorWhereInput {
  return {
    status: { in: statuses },
    campaign: openCampaignIn(view),
    influencer: { archived: false },
    nextActionDueAt: { lte: now },
  };
}
