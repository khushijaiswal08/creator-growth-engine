import type { CollaborationType, CreatorStatus, GiftOrderStatus, Platform, TemplatePurpose } from "@prisma/client";
import type { BrandScope } from "@/lib/brand-scope";
import { contentRate, engagementRate, monthlySeries, rachnaVerdict, reachMultiple, reachPerPost, type CreatorStats, type MonthPoint, type Verdict } from "@/lib/creator-card";
import { db } from "@/lib/db";
import { suggestedTemplate } from "@/lib/next-action";
import { CLOSED_STATUSES } from "@/lib/pipeline";
import { SEND_BLOCKED_STATUSES } from "@/lib/status";
import { firstName } from "@/lib/template";

/**
 * Everything the creator card shows, gathered in one query inside the
 * person's brand scope. Decimals become numbers so the card (a client
 * component) can take the whole thing as props.
 */

export type CardPost = {
  id: string;
  url: string;
  format: string | null;
  at: Date;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
  salesUsd: number | null;
  capturedAt: Date | null;
};

export type CardGift = {
  id: string;
  product: string;
  priceUsd: number | null;
  quantity: number;
  status: GiftOrderStatus;
  at: Date;
  delivered: boolean;
};

export type CardCampaign = {
  id: string;
  campaignId: string;
  name: string;
  status: CreatorStatus;
  collaborationType: CollaborationType | null;
  requestedFee: number | null;
  approvedFee: number | null;
  replyWarmth: string | null;
  replyRead: string | null;
  fitScore: number | null;
  gifts: CardGift[];
  posts: CardPost[];
};

export type CardMessageTarget = {
  campaignCreatorId: string;
  influencerName: string;
  status: CreatorStatus;
  profiles: { id: string; platform: Platform; handle: string }[];
  email: string | null;
  amazonCreator: boolean;
  blockedReason: string | null;
  purpose: TemplatePurpose | null;
};

export type CreatorCard = {
  influencer: {
    id: string;
    name: string;
    email: string | null;
    location: string | null;
    usSignal: number | null;
    amazonTier: string | null;
    amazonMonthlyGmvUsd: number | null;
    amazonGmvDetail: string | null;
    affiliateQuote: string | null;
    createdAt: Date;
  };
  profiles: { id: string; platform: Platform; handle: string; followers: number | null; engagementRate: number | null }[];
  stats: CreatorStats;
  verdict: Verdict;
  figures: { contentRate: number | null; reachPerPost: number | null; reachMultiple: number | null; engagementRate: number | null };
  campaigns: CardCampaign[];
  months: MonthPoint[];
  message: CardMessageTarget | null;
};

const num = (value: { toNumber(): number } | number | null | undefined): number | null => (value === null || value === undefined ? null : typeof value === "number" ? value : value.toNumber());

export async function loadCreatorCard(influencerId: string, scope: BrandScope, now = new Date()): Promise<CreatorCard | null> {
  const row = await db.influencer.findFirst({
    where: { id: influencerId, ...scope.influencers },
    select: {
      id: true,
      name: true,
      email: true,
      location: true,
      usSignal: true,
      amazonTier: true,
      amazonMonthlyGmvUsd: true,
      amazonGmvDetail: true,
      affiliateQuote: true,
      createdAt: true,
      profiles: { select: { id: true, platform: true, handle: true, followers: true, engagementRate: true }, orderBy: { platform: "asc" } },
      campaigns: {
        where: scope.creators,
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          status: true,
          collaborationType: true,
          requestedFee: true,
          approvedFee: true,
          replyWarmth: true,
          replyRead: true,
          fitScore: true,
          nextAction: true,
          campaign: { select: { id: true, name: true } },
          giftOrders: {
            where: { status: { not: "cancelled" } },
            orderBy: { createdAt: "desc" },
            select: { id: true, status: true, quantity: true, createdAt: true, shippedAt: true, deliveredAt: true, product: { select: { title: true, color: true, size: true, price: true } } },
          },
          posts: {
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              url: true,
              format: true,
              postedAt: true,
              createdAt: true,
              metrics: { orderBy: { capturedAt: "desc" }, take: 1, select: { views: true, likes: true, comments: true, shares: true, clicks: true, salesUsd: true, capturedAt: true } },
            },
          },
        },
      },
    },
  });
  if (!row) return null;

  const campaigns: CardCampaign[] = row.campaigns.map((link) => ({
    id: link.id,
    campaignId: link.campaign.id,
    name: link.campaign.name,
    status: link.status,
    collaborationType: link.collaborationType,
    requestedFee: link.requestedFee,
    approvedFee: link.approvedFee,
    replyWarmth: link.replyWarmth,
    replyRead: link.replyRead,
    fitScore: link.fitScore,
    gifts: link.giftOrders.map((gift) => ({
      id: gift.id,
      product: [gift.product.title, gift.product.color, gift.product.size].filter(Boolean).join(", "),
      priceUsd: num(gift.product.price),
      quantity: gift.quantity,
      status: gift.status,
      at: gift.deliveredAt ?? gift.shippedAt ?? gift.createdAt,
      delivered: gift.deliveredAt !== null,
    })),
    posts: link.posts.map((post) => {
      const latest = post.metrics[0];
      return {
        id: post.id,
        url: post.url,
        format: post.format,
        at: post.postedAt ?? post.createdAt,
        views: latest?.views ?? null,
        likes: latest?.likes ?? null,
        comments: latest?.comments ?? null,
        shares: latest?.shares ?? null,
        clicks: latest?.clicks ?? null,
        salesUsd: num(latest?.salesUsd),
        capturedAt: latest?.capturedAt ?? null,
      };
    }),
  }));

  const gifts = campaigns.flatMap((link) => link.gifts);
  const posts = campaigns.flatMap((link) => link.posts);
  const sum = (values: (number | null)[]) => values.reduce<number>((total, value) => total + (value ?? 0), 0);
  const latest = (dates: Date[]) => dates.sort((a, b) => b.getTime() - a.getTime())[0] ?? null;

  const stats: CreatorStats = {
    firstName: firstName(row.name),
    gifts: gifts.length,
    giftValueUsd: sum(gifts.map((gift) => (gift.priceUsd === null ? null : gift.priceUsd * gift.quantity))),
    posts: posts.length,
    delivered: campaigns.filter((link) => link.status === "content_posted" || link.status === "completed").length,
    noContent: campaigns.filter((link) => link.status === "no_content").length,
    pending: campaigns.filter((link) => ["address_collected", "product_shipped", "content_expected"].includes(link.status)).length,
    reach: sum(posts.map((post) => post.views)),
    engagements: sum(posts.map((post) => (post.likes ?? 0) + (post.comments ?? 0) + (post.shares ?? 0))),
    clicks: sum(posts.map((post) => post.clicks)),
    salesUsd: sum(posts.map((post) => post.salesUsd)),
    followers: Math.max(0, ...row.profiles.map((profile) => profile.followers ?? 0)),
    fitScore: campaigns.map((link) => link.fitScore).find((score): score is number => score !== null) ?? null,
    lastGiftAt: latest(gifts.map((gift) => gift.at)),
    lastPostAt: latest(posts.map((post) => post.at)),
    amazonTier: row.amazonTier,
  };

  const open = row.campaigns.find((link) => !CLOSED_STATUSES.includes(link.status)) ?? null;
  const message: CardMessageTarget | null = open
    ? {
        campaignCreatorId: open.id,
        influencerName: row.name,
        status: open.status,
        profiles: row.profiles.map(({ id, platform, handle }) => ({ id, platform, handle })),
        email: row.email,
        amazonCreator: row.amazonTier !== null,
        blockedReason: SEND_BLOCKED_STATUSES.has(open.status) ? "Do not contact." : null,
        purpose: suggestedTemplate(open.status, open.nextAction),
      }
    : null;

  return {
    influencer: {
      id: row.id,
      name: row.name,
      email: row.email,
      location: row.location,
      usSignal: row.usSignal,
      amazonTier: row.amazonTier,
      amazonMonthlyGmvUsd: num(row.amazonMonthlyGmvUsd),
      amazonGmvDetail: row.amazonGmvDetail,
      affiliateQuote: row.affiliateQuote,
      createdAt: row.createdAt,
    },
    profiles: row.profiles,
    stats,
    verdict: rachnaVerdict(stats, now),
    figures: { contentRate: contentRate(stats), reachPerPost: reachPerPost(stats), reachMultiple: reachMultiple(stats), engagementRate: engagementRate(stats) },
    campaigns,
    months: monthlySeries(
      [...gifts.map((gift) => ({ at: gift.at, kind: "gift" as const })), ...posts.map((post) => ({ at: post.at, kind: "post" as const, reach: post.views ?? 0, salesUsd: post.salesUsd ?? 0 }))],
      6,
      now,
    ),
    message,
  };
}
