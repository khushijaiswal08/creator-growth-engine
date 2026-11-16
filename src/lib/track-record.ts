import type { Prisma } from "@prisma/client";
import type { BrandScope } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import { plural } from "@/lib/format";
import { DELIVERED_STATUSES, GIFT_IN_PROGRESS_STATUSES, type StatusTone } from "@/lib/status";

/** The newest post and newest live gift of each collaboration: what a list needs for "last post", "last gift" and "last collaboration". */
export const LATEST_POST_AND_GIFT = {
  posts: { select: { createdAt: true }, orderBy: { createdAt: "desc" }, take: 1 },
  giftOrders: { where: { status: { not: "cancelled" } }, select: { shippedAt: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 1 },
} as const satisfies Prisma.CampaignCreatorSelect;

/**
 * What a creator has done with the gifts they were sent, across every
 * campaign inside the scope. The one number the team wants before gifting
 * again: did they post last time?
 */
type TrackRecord = {
  /** Gift orders that were not cancelled. */
  gifts: number;
  /** Collaborations where content arrived (posted or completed). */
  delivered: number;
  /** Collaborations closed because the content never came. */
  noContent: number;
  /** Gifts still open: shipped, delivered or waiting for content. */
  pending: number;
  posts: number;
};

const EMPTY: TrackRecord = { gifts: 0, delivered: 0, noContent: 0, pending: 0, posts: 0 };

export async function trackRecordFor(influencerIds: string[], scope: BrandScope): Promise<Map<string, TrackRecord>> {
  if (influencerIds.length === 0) return new Map();
  return trackRecordWhere({ influencerId: { in: influencerIds } }, scope);
}

/**
 * The same records for the creators a filter picks, so a list can start this
 * query alongside its own instead of waiting for the ids. The scope is always
 * applied on top of the filter.
 */
export async function trackRecordWhere(where: Prisma.CampaignCreatorWhereInput, scope: BrandScope): Promise<Map<string, TrackRecord>> {
  const records = new Map<string, TrackRecord>();
  const links = await db.campaignCreator.findMany({
    where: { ...where, ...scope.creators },
    select: {
      influencerId: true,
      status: true,
      _count: { select: { posts: true, giftOrders: { where: { status: { not: "cancelled" } } } } },
    },
  });

  for (const link of links) {
    const record = { ...(records.get(link.influencerId) ?? EMPTY) };
    record.gifts += link._count.giftOrders;
    record.posts += link._count.posts;
    if (DELIVERED_STATUSES.has(link.status)) record.delivered += 1;
    else if (link.status === "no_content") record.noContent += 1;
    else if (GIFT_IN_PROGRESS_STATUSES.has(link.status)) record.pending += 1;
    records.set(link.influencerId, record);
  }
  return records;
}

/** A few words and a colour for the badge, or null when there is nothing to say yet. */
export function describeTrackRecord(record: TrackRecord | undefined): { text: string; tone: StatusTone } | null {
  if (!record) return null;
  if (record.noContent > 0 && record.delivered === 0) {
    return { text: `Took ${record.noContent === 1 ? "a gift" : `${record.noContent} gifts`}, never posted`, tone: "danger" };
  }
  if (record.noContent > 0) return { text: `${record.delivered} posted, ${record.noContent} no content`, tone: "warning" };
  if (record.delivered > 0) return { text: `${plural(record.delivered, "collaboration")} posted`, tone: "success" };
  if (record.pending > 0) return { text: `${plural(record.pending, "gift")} in progress`, tone: "primary" };
  return null;
}
