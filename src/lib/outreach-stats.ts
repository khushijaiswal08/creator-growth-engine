import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { startOfDayInZone, startOfWeekInZone } from "@/lib/format";

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
export const DEFAULT_TARGETS = { daily: 20, weekly: 100 };
const DAY_MS = 24 * 60 * 60 * 1000;

export type Targets = { daily: number; weekly: number };

export async function brandTargets(brandIds: string[]): Promise<Map<string, Targets>> {
  const rows = await db.brandSettings.findMany({ where: { brandId: { in: brandIds } } });
  const map = new Map<string, Targets>();
  for (const brandId of brandIds) {
    const row = rows.find((item) => item.brandId === brandId);
    map.set(brandId, row ? { daily: row.dailyMessageTarget, weekly: row.weeklyMessageTarget } : { ...DEFAULT_TARGETS });
  }
  return map;
}

export type PersonStats = {
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
  return stats.creators > 0 ? Math.round((stats.replies / stats.creators) * 100) : null;
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
    db.activity.groupBy({ by: ["userId"], where: { kind: "status_change", createdAt: at, body: { contains: " to Agreed" }, automated: false, ...inCampaign }, _count: { _all: true } }),
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

export type TodayStats = { today: PersonStats[]; week: PersonStats[]; dayStart: Date; weekStart: Date };

/** Today and this week (Monday onwards), in the app's time zone. */
export async function todayStats(campaign: Prisma.CampaignWhereInput, now = new Date()): Promise<TodayStats> {
  const dayStart = startOfDayInZone(now);
  const weekStart = startOfWeekInZone(now);
  const [today, week] = await Promise.all([personStats({ from: dayStart, to: now }, campaign), personStats({ from: weekStart, to: now }, campaign)]);
  return { today, week, dayStart, weekStart };
}

export type WeekRow = { weekStart: Date; weekEnd: Date; people: PersonStats[] };

/** The last `weeks` whole weeks plus the current one, newest first. */
export async function weeklyStats(campaign: Prisma.CampaignWhereInput, weeks = 8, now = new Date()): Promise<WeekRow[]> {
  const thisWeek = startOfWeekInZone(now);
  const rows: WeekRow[] = [];
  for (let index = 0; index < weeks; index += 1) {
    const weekStart = new Date(thisWeek.getTime() - index * 7 * DAY_MS);
    const weekEnd = new Date(weekStart.getTime() + 7 * DAY_MS);
    rows.push({ weekStart, weekEnd, people: await personStats({ from: weekStart, to: weekEnd }, campaign) });
  }
  return rows;
}
