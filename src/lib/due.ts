import type { CreatorStatus, Prisma } from "@prisma/client";
import type { BrandScope } from "@/lib/brand-scope";

/**
 * What needs a person today, most urgent first. A creator appears in one
 * group only. Shared by the home page (the task list) and the shell (the
 * count on the bell), so both always agree.
 */
export const QUEUES: {
  key: string;
  title: string;
  /** The chip name on Home's tabs. */
  short: string;
  statuses: CreatorStatus[];
  message: boolean;
}[] = [
  { key: "replies", title: "Reply today", short: "Replies", statuses: ["replied", "negotiating"], message: true },
  { key: "selection", title: "Send the product link", short: "Links", statuses: ["interested", "agreed"], message: true },
  { key: "followups", title: "Follow-ups due", short: "Follow-ups", statuses: ["follow_up_due"], message: true },
  { key: "first", title: "First messages", short: "First messages", statuses: ["approved", "outreach_scheduled"], message: true },
  { key: "gifts", title: "Gifts needing you", short: "Gifts", statuses: ["address_collected"], message: false },
  { key: "delivery", title: "Parcels to check", short: "Parcels", statuses: ["product_shipped"], message: false },
  { key: "content", title: "Content to chase", short: "Content", statuses: ["content_expected"], message: true },
  { key: "posted", title: "Posts to check", short: "Posts", statuses: ["content_posted"], message: false },
  { key: "review", title: "To review", short: "Review", statuses: ["discovered", "scored"], message: false },
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
