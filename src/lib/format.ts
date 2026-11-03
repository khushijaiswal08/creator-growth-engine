// The team's time zone is a deployment setting (APP_TIME_ZONE). next.config.ts passes it to the browser too, so server and page format dates the same way.
const TIME_ZONE = process.env.APP_TIME_ZONE?.trim() || "UTC";

const dateTime = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: TIME_ZONE,
});

const zoneName =
  new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, timeZoneName: "short" })
    .formatToParts(new Date())
    .find((part) => part.type === "timeZoneName")?.value ?? TIME_ZONE;

const day = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: TIME_ZONE });

// Date-only values (deadlines) are stored at midnight UTC and must not shift with the zone.
const calendarDay = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

export const formatDateTime = (date: Date) => `${dateTime.format(date)} ${zoneName}`;
export const formatDay = (date: Date | null) => (date ? day.format(date) : "");
export const formatCalendarDay = (date: Date | null) => (date ? calendarDay.format(date) : "");
export const formatCount = (value: number | null) => (value === null ? "" : compact.format(value));
/** "$1,250": whole US dollars with thousands separators. (formatUsd in model-prices.ts shows cents, for AI costs.) */
export const formatDollars = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;
/** "reel" -> "Reel". For a word that is never empty. */
export const capitalize = (word: string) => word[0].toUpperCase() + word.slice(1);
/** "1 gift", "3 gifts". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "1 day late", "4 days late". Callers word the zero case themselves. */
export const daysLateText = (days: number) => `${plural(days, "day")} late`;
/** "2026-10-28": the UTC calendar date, for file names, CSV cells and report labels. */
export const isoDay = (date: Date) => date.toISOString().slice(0, 10);
/** Part of a total as a whole percent; null when the total is zero. */
export const wholePercent = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : null);

// "Oct 26" and "October 2026", for week and month rows.
const shortDay = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: TIME_ZONE });
const monthYear = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: TIME_ZONE });
export const formatShortDay = (date: Date) => shortDay.format(date);
export const formatMonth = (date: Date) => monthYear.format(date);

// For the greeting on Today: the hour where the team sits, not on the server.
const hourOfDay = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: TIME_ZONE });
const longDay = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: TIME_ZONE });

/** 0 to 23 on the team's clock (APP_TIME_ZONE), whatever zone the server or the computer is in. */
export const hourInZone = (date: Date) => Number(hourOfDay.format(date)) % 24;

/** Morning from 5 until noon, afternoon until five, evening after that and through the night. */
export function partOfDay(hour: number): "morning" | "afternoon" | "evening" {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  return "evening";
}

/** The part of the day a moment falls in, on the team's clock. */
export function timeOfDay(date: Date): "morning" | "afternoon" | "evening" {
  return partOfDay(hourInZone(date));
}

/** "just now", "12 minutes ago", "3 hours ago", "yesterday", "4 days ago", then the date. */
export function timeAgo(date: Date, now = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour")} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  return formatDay(date);
}

/** "Tuesday 6 October" */
export const todayWords = (date: Date) =>
  longDay.formatToParts(date).reduce((text, part) => {
    if (part.type === "weekday") return part.value;
    if (part.type === "day") return `${text} ${part.value}`;
    if (part.type === "month") return `${text} ${part.value}`;
    return text;
  }, "");

/** The most recent of the dates given, ignoring blanks; null when there is none. */
export function latestDate(dates: readonly (Date | null | undefined)[]): Date | null {
  return dates.filter((date): date is Date => Boolean(date)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
}

// Day and week boundaries where the team sits, for "today" and "this week" counts.
const zoneParts = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  weekday: "short",
  timeZoneName: "longOffset",
});
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** One day in milliseconds, for "days late" and "days ago" sums. Elapsed time, not a calendar day in any zone. */
export const DAY_MS = 24 * 60 * 60 * 1000;

function partsOf(date: Date): Record<string, string> {
  return Object.fromEntries(zoneParts.formatToParts(date).map((part) => [part.type, part.value]));
}

/** "GMT+05:30" -> its offset in milliseconds; 0 when there is none. */
export function gmtOffsetMs(timeZoneName: string | undefined): number {
  const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(timeZoneName ?? "");
  if (!match) return 0;
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0)) * 60 * 1000;
}

/** Midnight at the start of the given moment's day, in the app's time zone. */
export function startOfDayInZone(date: Date): Date {
  const parts = partsOf(date);
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - gmtOffsetMs(parts.timeZoneName));
}

/** Midnight at the start of the given moment's week (Monday), in the app's time zone. */
export function startOfWeekInZone(date: Date): Date {
  const index = Math.max(0, WEEKDAYS.indexOf(partsOf(date).weekday));
  return new Date(startOfDayInZone(date).getTime() - index * DAY_MS);
}

// Month and quarter boundaries, and dates typed in a form, all in the app's time zone.
export function startOfMonthInZone(date: Date): Date {
  const parts = partsOf(date);
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, 1) - gmtOffsetMs(parts.timeZoneName));
}

export function startOfQuarterInZone(date: Date): Date {
  const parts = partsOf(date);
  const month = Math.floor((Number(parts.month) - 1) / 3) * 3;
  return new Date(Date.UTC(Number(parts.year), month, 1) - gmtOffsetMs(parts.timeZoneName));
}

/** "2026-10-01" (a date typed in a form) -> midnight at the start of that day in the app's zone. Null when not a date. */
export function parseDayInZone(text: string | null | undefined): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec((text ?? "").trim());
  if (!match) return null;
  const guess = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  if (Number.isNaN(guess.getTime())) return null;
  // The offset for that day (not today), so dates across a daylight-saving change stay right.
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - gmtOffsetMs(partsOf(guess).timeZoneName));
}

/** The same date as a form value, "2026-10-01", in the app's zone. */
export function dayValueInZone(date: Date): string {
  const parts = partsOf(date);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}
