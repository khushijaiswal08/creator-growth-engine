import { attributionByCampaignCreator } from "@/lib/amazon-stats";
import type { BrandScope } from "@/lib/brand-scope";
import { campaignNumbers, contentCount } from "@/lib/creator-card";
import { db } from "@/lib/db";
import { DELIVERED_STATUSES } from "@/lib/status";

/**
 * The creator card's headline figures for a page of creators at once, for the
 * Creators table: gifts and their value, content, views, clicks, Amazon orders
 * and sales, counted inside the scope and by the same rules as the card, so a
 * row and the card it opens never disagree.
 */
export type CreatorFigures = {
  gifts: number;
  /** Amazon price of the gifted products, summed; null when no gift has a price on file. */
  giftValueUsd: number | null;
  content: number;
  /** Latest views logged on the posts, summed; null when none are logged. */
  views: number | null;
  /** Null when no campaign has clicks or sales on file, from Amazon or typed in. */
  clicks: number | null;
  /** Amazon Attribution's orders; null when no Amazon report has counted anything. */
  orders: number | null;
  salesUsd: number | null;
};

export async function creatorFiguresFor(influencerIds: string[], scope: BrandScope): Promise<Map<string, CreatorFigures>> {
  const figures = new Map<string, CreatorFigures>();
  if (influencerIds.length === 0) return figures;

  const where = { ...scope.creators, influencerId: { in: influencerIds } };
  const [links, amazon] = await Promise.all([
    db.campaignCreator.findMany({
      where,
      select: {
        id: true,
        influencerId: true,
        status: true,
        giftOrders: { where: { status: { not: "cancelled" } }, select: { quantity: true, product: { select: { price: true } } } },
        posts: { select: { metrics: { orderBy: { capturedAt: "desc" }, take: 1, select: { views: true, clicks: true, salesUsd: true } } } },
      },
    }),
    attributionByCampaignCreator(where),
  ]);

  const tallies = new Map<string, { gifts: number; giftValue: number | null; posts: number; delivered: number; views: number | null; clicks: number | null; orders: number | null; sales: number | null }>();
  const add = (total: number | null, value: number | null) => (value === null ? total : (total ?? 0) + value);
  for (const link of links) {
    const tally = tallies.get(link.influencerId) ?? { gifts: 0, giftValue: null, posts: 0, delivered: 0, views: null, clicks: null, orders: null, sales: null };
    tally.gifts += link.giftOrders.length;
    for (const gift of link.giftOrders) tally.giftValue = add(tally.giftValue, gift.product.price === null ? null : gift.product.price.toNumber() * gift.quantity);
    tally.posts += link.posts.length;
    if (DELIVERED_STATUSES.has(link.status)) tally.delivered += 1;
    const latest = link.posts.map((post) => post.metrics[0]).filter((metric) => metric !== undefined);
    for (const metric of latest) tally.views = add(tally.views, metric.views);
    const numbers = campaignNumbers(
      amazon.get(link.id),
      latest.map((metric) => ({ clicks: metric.clicks, salesUsd: metric.salesUsd === null ? null : metric.salesUsd.toNumber() })),
    );
    if (numbers.source !== null) {
      tally.clicks = add(tally.clicks, numbers.clicks);
      tally.sales = add(tally.sales, numbers.salesUsd);
      tally.orders = add(tally.orders, numbers.orders);
    }
    tallies.set(link.influencerId, tally);
  }

  const cents = (value: number | null) => (value === null ? null : Math.round(value * 100) / 100);
  for (const [id, tally] of tallies) {
    figures.set(id, {
      gifts: tally.gifts,
      giftValueUsd: cents(tally.giftValue),
      content: contentCount({ posts: tally.posts, delivered: tally.delivered }),
      views: tally.views,
      clicks: tally.clicks,
      orders: tally.orders,
      salesUsd: cents(tally.sales),
    });
  }
  return figures;
}
