// Timestamps are rendered on the server, so the zone is a deployment setting.
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

// For the greeting on Today: the hour where the team sits, not on the server.
const hourOfDay = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: TIME_ZONE });
const longDay = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: TIME_ZONE });

export function timeOfDay(date: Date): "morning" | "afternoon" | "evening" {
  const hour = Number(hourOfDay.format(date)) % 24;
  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  return "evening";
}

/** "Tuesday 6 October" */
export const todayWords = (date: Date) =>
  longDay.formatToParts(date).reduce((text, part) => {
    if (part.type === "weekday") return part.value;
    if (part.type === "day") return `${text} ${part.value}`;
    if (part.type === "month") return `${text} ${part.value}`;
    return text;
  }, "");

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
const DAY_MS = 24 * 60 * 60 * 1000;

function partsOf(date: Date): Record<string, string> {
  return Object.fromEntries(zoneParts.formatToParts(date).map((part) => [part.type, part.value]));
}

function offsetMs(parts: Record<string, string>): number {
  const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(parts.timeZoneName ?? "");
  if (!match) return 0;
  return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0)) * 60 * 1000;
}

/** Midnight at the start of the given moment's day, in the app's time zone. */
export function startOfDayInZone(date: Date): Date {
  const parts = partsOf(date);
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - offsetMs(parts));
}

/** Midnight at the start of the given moment's week (Monday), in the app's time zone. */
export function startOfWeekInZone(date: Date): Date {
  const index = Math.max(0, WEEKDAYS.indexOf(partsOf(date).weekday));
  return new Date(startOfDayInZone(date).getTime() - index * DAY_MS);
}
