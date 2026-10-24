import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { dayValueInZone, parseDayInZone, startOfDayInZone, startOfMonthInZone, startOfQuarterInZone, startOfWeekInZone } from "@/lib/format";

/**
 * The performance figures for any period: how many creators moved through
 * each step, what shipped, what came back, within a brand or one campaign.
 * Every figure counts events whose own date falls in the period (a status
 * change, a shipment, a post), so a creator contacted in March and posting in
 * May counts once in each month, which is what a monthly report should show.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

export type Period = { from: Date; to: Date; label: string; key: string };

export const PERIOD_KEYS = ["this-week", "last-week", "this-month", "last-month", "this-quarter", "last-quarter", "custom"] as const;
export type PeriodKey = (typeof PERIOD_KEYS)[number];

export const PERIOD_LABELS: Record<PeriodKey, string> = {
  "this-week": "This week",
  "last-week": "Last week",
  "this-month": "This month",
  "last-month": "Last month",
  "this-quarter": "This quarter",
  "last-quarter": "Last quarter",
  custom: "Custom dates",
};

function monthsLater(start: Date, months: number): Date {
  // Walk forward by whole months in the app zone: take the day after the last day of the target month.
  const probe = new Date(start.getTime() + months * 31 * DAY_MS + 2 * DAY_MS);
  return startOfMonthInZone(probe);
}

/** Resolves a period choice (and custom dates) to exact boundaries. Unknown input means this week. */
export function resolvePeriod(key: string | undefined, from: string | undefined, to: string | undefined, now = new Date()): Period {
  const chosen = (PERIOD_KEYS as readonly string[]).includes(key ?? "") ? (key as PeriodKey) : "this-week";
  const thisWeek = startOfWeekInZone(now);
  const thisMonth = startOfMonthInZone(now);
  const thisQuarter = startOfQuarterInZone(now);
  switch (chosen) {
    case "last-week":
      return { key: chosen, label: PERIOD_LABELS[chosen], from: new Date(thisWeek.getTime() - 7 * DAY_MS), to: thisWeek };
    case "this-month":
      return { key: chosen, label: PERIOD_LABELS[chosen], from: thisMonth, to: monthsLater(thisMonth, 1) };
    case "last-month": {
      const lastMonth = startOfMonthInZone(new Date(thisMonth.getTime() - 2 * DAY_MS));
      return { key: chosen, label: PERIOD_LABELS[chosen], from: lastMonth, to: thisMonth };
    }
    case "this-quarter":
      return { key: chosen, label: PERIOD_LABELS[chosen], from: thisQuarter, to: monthsLater(thisQuarter, 3) };
    case "last-quarter": {
      const lastQuarter = startOfQuarterInZone(new Date(thisQuarter.getTime() - 2 * DAY_MS));
      return { key: chosen, label: PERIOD_LABELS[chosen], from: lastQuarter, to: thisQuarter };
    }
    case "custom": {
      const start = parseDayInZone(from);
      const end = parseDayInZone(to);
      if (start && end && end >= start) return { key: chosen, label: `${from} to ${to}`, from: start, to: new Date(end.getTime() + DAY_MS) };
      return { key: "this-week", label: PERIOD_LABELS["this-week"], from: thisWeek, to: new Date(thisWeek.getTime() + 7 * DAY_MS) };
    }
    default:
      return { key: "this-week", label: PERIOD_LABELS["this-week"], from: thisWeek, to: new Date(thisWeek.getTime() + 7 * DAY_MS) };
  }
}

export type Figures = {
  creatorsAdded: number;
  messages: number;
  replies: number;
  contacted: number;
  agreed: number;
  giftsOrdered: number;
  giftsShipped: number;
  giftsDelivered: number;
  posted: number;
  completed: number;
  noContent: number;
  /** Posts that came back as a share of collaborations that ended in the period (posted + no content), or null. */
  contentRate: number | null;
};

export const FIGURE_LABELS: Record<keyof Figures, string> = {
  creatorsAdded: "Creators added",
  messages: "Messages sent",
  replies: "Replies",
  contacted: "Contacted",
  agreed: "Agreed",
  giftsOrdered: "Gifts chosen",
  giftsShipped: "Gifts shipped",
  giftsDelivered: "Gifts delivered",
  posted: "Content posted",
  completed: "Completed",
  noContent: "No content delivered",
  contentRate: "Content rate",
};

export async function figuresFor(range: { from: Date; to: Date }, campaign: Prisma.CampaignWhereInput): Promise<Figures> {
  const at = { gte: range.from, lt: range.to };
  const inCampaign = { campaignCreator: { campaign } };
  const moved = (to: string) => db.activity.count({ where: { kind: "status_change", createdAt: at, body: { contains: ` to ${to}` }, ...inCampaign } });
  const [creatorsAdded, messages, replies, contacted, agreed, giftsOrdered, giftsShipped, giftsDelivered, posted, completed, noContent] = await Promise.all([
    db.campaignCreator.count({ where: { createdAt: at, campaign } }),
    db.message.count({ where: { direction: "outbound", sentAt: at, ...inCampaign } }),
    db.message.count({ where: { direction: "inbound", sentAt: at, ...inCampaign } }),
    moved("Contacted"),
    moved("Agreed"),
    db.giftOrder.count({ where: { createdAt: at, status: { not: "cancelled" }, ...inCampaign } }),
    db.giftOrder.count({ where: { shippedAt: at, ...inCampaign } }),
    db.giftOrder.count({ where: { deliveredAt: at, ...inCampaign } }),
    db.post.count({ where: { createdAt: at, ...inCampaign } }),
    moved("Completed"),
    moved("No content delivered"),
  ]);
  const finished = posted + noContent;
  return { creatorsAdded, messages, replies, contacted, agreed, giftsOrdered, giftsShipped, giftsDelivered, posted, completed, noContent, contentRate: finished > 0 ? Math.round((posted / finished) * 100) : null };
}

/** Rachna's reading of replies in a period: how many, how many hot, how often the team agreed, how fast hot ones were answered. */
export type ReadingFigures = { repliesRead: number; hot: number; agreed: number; accuracy: number | null; hotAnsweredInDay: number | null };

export async function readingFiguresFor(range: { from: Date; to: Date }, campaign: Prisma.CampaignWhereInput): Promise<ReadingFigures> {
  const at = { gte: range.from, lt: range.to };
  const read = await db.message.findMany({
    where: { direction: "inbound", sentAt: at, suggestedClass: { not: null }, campaignCreator: { campaign } },
    select: { campaignCreatorId: true, sentAt: true, suggestedClass: true, classification: true, warmth: true },
    take: 5000,
  });
  const hot = read.filter((row) => row.warmth === "hot");
  const agreed = read.filter((row) => row.suggestedClass === row.classification).length;
  let hotAnsweredInDay: number | null = null;
  if (hot.length > 0) {
    const answers = await db.message.findMany({
      where: { direction: "outbound", campaignCreatorId: { in: [...new Set(hot.map((row) => row.campaignCreatorId))] }, sentAt: { gte: range.from } },
      select: { campaignCreatorId: true, sentAt: true },
    });
    const inADay = hot.filter((row) => answers.some((answer) => answer.campaignCreatorId === row.campaignCreatorId && answer.sentAt > row.sentAt && answer.sentAt.getTime() - row.sentAt.getTime() <= DAY_MS)).length;
    hotAnsweredInDay = Math.round((inADay / hot.length) * 100);
  }
  return { repliesRead: read.length, hot: hot.length, agreed, accuracy: read.length > 0 ? Math.round((agreed / read.length) * 100) : null, hotAnsweredInDay };
}

export type Bucket = { from: Date; to: Date; label: string; figures: Figures };

/** The period split into weeks (short periods) or months (long ones), oldest first. */
export async function bucketsFor(period: Period, campaign: Prisma.CampaignWhereInput): Promise<Bucket[]> {
  const days = (period.to.getTime() - period.from.getTime()) / DAY_MS;
  const byMonth = days > 70;
  const buckets: Bucket[] = [];
  let cursor = byMonth ? startOfMonthInZone(period.from) : startOfWeekInZone(period.from);
  if (cursor < period.from) cursor = period.from;
  let guard = 0;
  while (cursor < period.to && guard < 60) {
    guard += 1;
    const next = byMonth ? monthsLater(startOfMonthInZone(new Date(cursor.getTime() + DAY_MS)), 1) : new Date(startOfWeekInZone(new Date(cursor.getTime() + DAY_MS)).getTime() + 7 * DAY_MS);
    const end = next > period.to ? period.to : next;
    buckets.push({ from: cursor, to: end, label: byMonth ? dayValueInZone(cursor).slice(0, 7) : `Week of ${dayValueInZone(cursor)}`, figures: await figuresFor({ from: cursor, to: end }, campaign) });
    cursor = end;
  }
  return buckets;
}

/** The period of the same length just before this one, for the "vs previous" comparison. */
export function previousPeriod(period: Period): { from: Date; to: Date } {
  const length = period.to.getTime() - period.from.getTime();
  return { from: new Date(period.from.getTime() - length), to: period.from };
}

export { startOfDayInZone };
