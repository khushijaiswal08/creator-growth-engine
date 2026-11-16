import type { Prisma } from "@prisma/client";
import { cache } from "react";
import { inBatches } from "@/lib/batches";
import { allowed } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import { DAY_MS, startOfDayInZone, startOfWeekInZone, wholePercent } from "@/lib/format";
import { TIDY_NOTE } from "@/lib/tidy-up-rules";

/**
 * One definition of every outreach figure, used by Today, the outreach
 * report and the weekly email, so the same number means the same thing
 * everywhere:
 *
 *   messages        outbound messages the person logged with the Message button
 *   creators        distinct creators those messages went to
 *   replies         replies the person logged (inbound messages)
 *   reply rate      replies ÷ creators messaged (null when nobody was messaged)
 *   follow-ups      outbound messages sent with a follow-up template
 *   agreed          creators the person moved to Agreed
 *   shipped         gift orders shipped to creators the person owns
 *   posted          posts recorded for creators the person owns
 */

type Targets = {
  daily: number;
  weekly: number;
  /** The brand's Creator Connections page in the Amazon Ads console, which the Message button opens. */
  creatorConnectionsUrl: string | null;
};
const DEFAULT_TARGETS: Targets = { daily: 20, weekly: 100, creatorConnectionsUrl: null };

export async function brandTargets(brandIds: string[]): Promise<Map<string, Targets>> {
  const rows = await db.brandSettings.findMany({ where: { brandId: { in: brandIds } } });
  const map = new Map<string, Targets>();
  for (const brandId of brandIds) {
    const row = rows.find((item) => item.brandId === brandId);
    map.set(brandId, row ? { daily: row.dailyMessageTarget, weekly: row.weeklyMessageTarget, creatorConnectionsUrl: row.creatorConnectionsUrl } : { ...DEFAULT_TARGETS });
  }
  return map;
}

// The frame and Home both show these within one request; React's cache runs each query once per request.
// Automation runs never change brand settings or gifts waiting for approval, so sharing them cannot show a stale figure.
// Keyed by plain values, since the cache compares arguments by identity.
const targetsByKey = cache((key: string) => brandTargets(key ? key.split(",") : []));

/** brandTargets, shared by the frame and Home within one request. */
export function sharedBrandTargets(brandIds: string[]): Promise<Map<string, Targets>> {
  return targetsByKey(brandIds.join(","));
}

/** Gift orders waiting for approval in a viewed brand (null: both), shared by the frame and Home within one request. */
export const giftsToApprove = cache(async (brandId: string | null) =>
  // A viewed scope depends on its brand alone, so it is rebuilt from it here.
  db.giftOrder.count({ where: { ...allowed({ id: "", brandId, viewBrand: null }).gifts, status: "needs_approval" } }),
);

type PersonStats = {
  userId: string;
  name: string;
  messages: number;
  creators: number;
  replies: number;
  followUps: number;
  agreed: number;
  shipped: number;
  posted: number;
};

export function replyRate(stats: { replies: number; creators: number }): number | null {
  return wholePercent(stats.replies, stats.creators);
}

type Period = { from: Date; to: Date };

/** Every figure per person for one period, within the campaigns given (a brand's, or one campaign). */
export async function personStats(period: Period, campaign: Prisma.CampaignWhereInput): Promise<PersonStats[]> {
  const at = { gte: period.from, lt: period.to };
  const inCampaign = { campaignCreator: { campaign } };
  const [sent, perCreator, replies, followUps, agreed, shipped, posted] = await Promise.all([
    db.message.groupBy({ by: ["userId"], where: { direction: "outbound", sentAt: at, ...inCampaign }, _count: { _all: true } }),
    db.message.groupBy({ by: ["userId", "campaignCreatorId"], where: { direction: "outbound", sentAt: at, ...inCampaign } }),
    db.message.groupBy({ by: ["userId"], where: { direction: "inbound", sentAt: at, ...inCampaign }, _count: { _all: true } }),
    db.message.groupBy({ by: ["userId"], where: { direction: "outbound", sentAt: at, template: { purpose: "followup" }, ...inCampaign }, _count: { _all: true } }),
    db.activity.groupBy({ by: ["userId"], where: { kind: "status_change", createdAt: at, body: { contains: " to Agreed" }, NOT: { body: { startsWith: TIDY_NOTE } }, automated: false, ...inCampaign }, _count: { _all: true } }),
    db.giftOrder.findMany({ where: { shippedAt: at, campaignCreator: { campaign, ownerId: { not: null } } }, select: { campaignCreator: { select: { ownerId: true } } } }),
    db.post.findMany({ where: { createdAt: at, campaignCreator: { campaign, ownerId: { not: null } } }, select: { campaignCreator: { select: { ownerId: true } } } }),
  ]);

  const ids = new Set<string>();
  for (const row of [...sent, ...replies, ...followUps, ...agreed]) ids.add(row.userId);
  for (const row of [...shipped, ...posted]) if (row.campaignCreator.ownerId) ids.add(row.campaignCreator.ownerId);
  if (ids.size === 0) return [];

  const people = await db.user.findMany({ where: { id: { in: [...ids] }, isSystem: false }, select: { id: true, name: true } });
  const count = (rows: { userId: string; _count: { _all: number } }[], userId: string) => rows.find((row) => row.userId === userId)?._count._all ?? 0;
  const owned = (rows: { campaignCreator: { ownerId: string | null } }[], userId: string) => rows.filter((row) => row.campaignCreator.ownerId === userId).length;

  return people
    .map((person) => ({
      userId: person.id,
      name: person.name,
      messages: count(sent, person.id),
      creators: perCreator.filter((row) => row.userId === person.id).length,
      replies: count(replies, person.id),
      followUps: count(followUps, person.id),
      agreed: count(agreed, person.id),
      shipped: owned(shipped, person.id),
      posted: owned(posted, person.id),
    }))
    .sort((a, b) => b.messages - a.messages || a.name.localeCompare(b.name));
}

/**
 * One person's own figures for Home: messages this week and today, replies this week and last week.
 * The same filters as personStats, narrowed to the one person, so Home skips everyone else's figures.
 */
export async function ownOutreach(userId: string, campaign: Prisma.CampaignWhereInput, lastWeek: Period, now = new Date()) {
  const inCampaign = { campaignCreator: { campaign } };
  const count = (direction: "outbound" | "inbound", from: Date, to: Date) => db.message.count({ where: { userId, direction, sentAt: { gte: from, lt: to }, ...inCampaign } });
  const weekStart = startOfWeekInZone(now);
  const [weekMessages, todayMessages, weekReplies, lastWeekReplies] = await Promise.all([
    count("outbound", weekStart, now),
    count("outbound", startOfDayInZone(now), now),
    count("inbound", weekStart, now),
    count("inbound", lastWeek.from, lastWeek.to),
  ]);
  return { weekMessages, todayMessages, weekReplies, lastWeekReplies };
}

/** How many weeks the outreach report and its CSV look back. */
export const OUTREACH_WEEKS = 8;

type WeekRow = { weekStart: Date; weekEnd: Date; people: PersonStats[] };

/** The current week and the weeks before it, `weeks` in all, newest first. */
export async function weeklyStats(campaign: Prisma.CampaignWhereInput, weeks = OUTREACH_WEEKS, now = new Date()): Promise<WeekRow[]> {
  const thisWeek = startOfWeekInZone(now);
  const pairs = Array.from({ length: weeks }, (_, index) => {
    const weekStart = new Date(thisWeek.getTime() - index * 7 * DAY_MS);
    return { weekStart, weekEnd: new Date(weekStart.getTime() + 7 * DAY_MS) };
  });
  // The weeks do not depend on each other: two at a time (seven counts each) rather than one after another,
  // and never all eight at once, which would queue past the connection pool's wait limit.
  const people = await inBatches(pairs, 2, ({ weekStart, weekEnd }) => personStats({ from: weekStart, to: weekEnd }, campaign));
  return pairs.map((pair, index) => ({ ...pair, people: people[index] }));
}
