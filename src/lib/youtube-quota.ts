import { db } from "@/lib/db";

/**
 * YouTube's Data API allows 10,000 quota units a day by default, reset at
 * midnight Pacific Time. Every run records the units it used; this ledger adds
 * them up for the current Pacific day, and discovery refuses to start a search
 * that would take the day past 80% of the allowance, so ordinary use never
 * trips the hard limit.
 */
export const QUOTA_STOP_SHARE = 0.8;
const DEFAULT_DAILY_QUOTA = 10_000;

const pacific = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  timeZoneName: "longOffset",
});

export function youtubeDailyQuota(): number {
  const configured = Number(process.env.YOUTUBE_DAILY_QUOTA ?? "");
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_DAILY_QUOTA;
}

/** Midnight Pacific Time at the start of the given moment's day. */
export function pacificDayStart(now: Date): Date {
  const parts = Object.fromEntries(pacific.formatToParts(now).map((part) => [part.type, part.value]));
  const offset = /GMT([+-])(\d{2}):?(\d{2})?/.exec(parts.timeZoneName ?? "");
  const offsetMs = offset ? (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3] ?? 0)) * 60_000 : 0;
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - offsetMs);
}

export type YoutubeBudget = {
  daily: number;
  /** Units we allow ourselves per day: 80% of the allowance. */
  limit: number;
  usedToday: number;
  remaining: number;
};

/** Units used by every YouTube run that started today (Pacific), plus what is still allowed. */
export async function youtubeBudget(now = new Date()): Promise<YoutubeBudget> {
  const daily = youtubeDailyQuota();
  const limit = Math.floor(daily * QUOTA_STOP_SHARE);
  const used = await db.discoveryRun.aggregate({
    where: { source: "youtube", startedAt: { gte: pacificDayStart(now) } },
    _sum: { quotaUsed: true },
  });
  const usedToday = used._sum.quotaUsed ?? 0;
  return { daily, limit, usedToday, remaining: Math.max(0, limit - usedToday) };
}
