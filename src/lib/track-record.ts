import type { BrandScope } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import type { StatusTone } from "@/lib/status";

/**
 * What a creator has done with the gifts they were sent, across every
 * campaign inside the scope. The one number the team wants before gifting
 * again: did they post last time?
 */
export type TrackRecord = {
  /** Gift orders that were not cancelled. */
  gifts: number;
  /** Collaborations where content arrived (posted or completed). */
  delivered: number;
  /** Collaborations closed because the content never came. */
  noContent: number;
  /** Gifts still open: shipped, delivered or waiting for content. */
  pending: number;
  posts: number;
  lastContactedAt: Date | null;
};

const EMPTY: TrackRecord = { gifts: 0, delivered: 0, noContent: 0, pending: 0, posts: 0, lastContactedAt: null };

export async function trackRecordFor(influencerIds: string[], scope: BrandScope): Promise<Map<string, TrackRecord>> {
  const records = new Map<string, TrackRecord>();
  if (influencerIds.length === 0) return records;

  const links = await db.campaignCreator.findMany({
    where: { influencerId: { in: influencerIds }, ...scope.creators },
    select: {
      influencerId: true,
      status: true,
      lastContactedAt: true,
      _count: { select: { posts: true, giftOrders: { where: { status: { not: "cancelled" } } } } },
    },
  });

  for (const link of links) {
    const record = { ...(records.get(link.influencerId) ?? EMPTY) };
    record.gifts += link._count.giftOrders;
    record.posts += link._count.posts;
    if (link.status === "content_posted" || link.status === "completed") record.delivered += 1;
    else if (link.status === "no_content") record.noContent += 1;
    else if (["address_collected", "product_shipped", "content_expected"].includes(link.status)) record.pending += 1;
    if (link.lastContactedAt && (!record.lastContactedAt || link.lastContactedAt > record.lastContactedAt)) {
      record.lastContactedAt = link.lastContactedAt;
    }
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
  if (record.delivered > 0) return { text: `${record.delivered} ${record.delivered === 1 ? "collaboration" : "collaborations"} posted`, tone: "success" };
  if (record.pending > 0) return { text: `${record.pending} gift${record.pending === 1 ? "" : "s"} in progress`, tone: "primary" };
  return null;
}
