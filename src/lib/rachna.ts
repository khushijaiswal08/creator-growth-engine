import type { CreatorStatus } from "@prisma/client";
import { warmthRank, type Warmth } from "@/lib/reply-reader";

/**
 * Rachna, the guide: the rules behind her, kept free of the browser so they
 * can be tested. She greets once a day, nudges once per creator per session,
 * cheers a few milestones, naps after ten quiet minutes, and never covers a
 * button or a field. When tips are off only the "?" tour remains.
 */
export type RachnaPose = "idle" | "point" | "cheer" | "think" | "sleep" | "happy" | "worried";
export type TipKind = "greeting" | "nudge" | "milestone" | "tour" | "intro";

/** Set by the sign-in action and read once by the app layout: she introduces herself on that visit. */
export const RACHNA_INTRO_COOKIE = "cge_intro";

export const IDLE_MS = 10 * 60 * 1000;
export const CONFETTI_MS = 3200;

/** Everything but the tour obeys the person's toggle. */
export function tipsAllowed(showTips: boolean, kind: TipKind): boolean {
  return kind === "tour" || showTips;
}

/** "2026-10-23" in the browser's own day, so the first visit each morning counts locally. */
export function dayKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The greeting shows on the first visit of each day and not again until tomorrow. */
export function greetingDue(lastGreetedDay: string | null, today: string): boolean {
  return lastGreetedDay !== today;
}

export function storageKey(userId: string, part: string): string {
  return `cge:rachna:${userId}:${part}`;
}

export type Speech = { pose: RachnaPose; text: string; action?: { label: string; href: string } };

/** The morning note, built from the real counts. A count of zero drops its clause. */
/** "Morning" until noon, "Afternoon" until five, "Evening" after: she matches the page's own greeting. */
export function timeOfDay(hour: number): "Morning" | "Afternoon" | "Evening" {
  if (hour < 12) return "Morning";
  if (hour < 17) return "Afternoon";
  return "Evening";
}

export function greetingFor(name: string, counts: { replies: number; parcels: number; total: number }, hour = new Date().getHours()): Speech {
  if (counts.total === 0) return { pose: "think", text: "Nothing due today. Go find two new creators?", action: { label: "Check a profile", href: "/influencers/new" } };
  const parts: string[] = [];
  if (counts.replies > 0) parts.push(`${counts.replies} ${counts.replies === 1 ? "reply" : "replies"} first`);
  if (counts.parcels > 0) parts.push(`${counts.parcels} parcel ${counts.parcels === 1 ? "check" : "checks"}`);
  if (parts.length === 0) parts.push(`${counts.total} ${counts.total === 1 ? "thing" : "things"} on the list`);
  const joined = parts.length === 2 ? `${parts[0]}, then ${parts[1]}` : parts[0];
  return { pose: "point", text: `${timeOfDay(hour)}, ${name}! ${joined.charAt(0).toUpperCase()}${joined.slice(1)}.` };
}

/** One contextual nudge after a status change; null for statuses that get none. */
export function nudgeFor(status: CreatorStatus, context: { arrivalDays?: number } = {}): Speech | null {
  switch (status) {
    case "agreed":
      return { pose: "point", text: "Send the selection link, one click." };
    case "content_expected":
      return { pose: "idle", text: `Delivery note today, arrival check in ${context.arrivalDays ?? 3} days. I'll remind you.` };
    case "content_posted":
      return { pose: "cheer", text: "Logged. Thank-you template is ready." };
    default:
      return null;
  }
}

export const MILESTONES = {
  weeklyTarget: (target: number): Speech => ({ pose: "cheer", text: `Weekly target reached: ${target} messages. Nice work.` }),
  dayCleared: (): Speech => ({ pose: "cheer", text: "Day cleared! Every quest done. Go find two new creators, or put your feet up.", action: { label: "Check a profile", href: "/influencers/new" } }),
  firstDelivery: (campaign: string): Speech => ({ pose: "cheer", text: `First gift delivered in ${campaign}.` }),
  tenthPost: (): Speech => ({ pose: "cheer", text: "That's the 10th post logged. Ten!" }),
};

/** Which tour a page gets, from its address. */
export function tourKeyFor(pathname: string): "home" | "creators" | "pipeline" | "gifts" | "reports" | null {
  if (pathname === "/today") return "home";
  if (pathname === "/influencers") return "creators";
  if (/^\/campaigns\/[^/]+$/.test(pathname)) return "pipeline";
  if (pathname === "/orders") return "gifts";
  if (pathname.startsWith("/reports")) return "reports";
  return null;
}

export type Rect = { x: number; y: number; w: number; h: number };

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export type Placement = { x: number; y: number; placement: "below" | "right" | "above" | "corner" };

/**
 * Where the bubble (figure plus speech) goes: below the anchor's left edge,
 * else to its right, else above, else the bottom-right corner. A spot is only
 * taken when it is inside the window and covers none of the blocked
 * rectangles (buttons, fields, anything marked data-no-overlay). With no
 * anchor she goes straight to the corner.
 */
export function placeBubble(input: { anchor: Rect | null; size: { w: number; h: number }; viewport: { w: number; h: number }; blocked: Rect[]; margin?: number }): Placement {
  const { anchor, size, viewport, blocked } = input;
  const margin = input.margin ?? 12;
  const corner: Placement = { x: Math.max(margin, viewport.w - size.w - margin), y: Math.max(margin, viewport.h - size.h - margin), placement: "corner" };
  if (!anchor) return corner;

  const candidates: Placement[] = [
    { x: anchor.x + 56, y: anchor.y + anchor.h + margin, placement: "below" },
    { x: anchor.x + anchor.w + margin, y: anchor.y - 8, placement: "right" },
    { x: anchor.x + 56, y: anchor.y - size.h - margin, placement: "above" },
  ];
  for (const candidate of candidates) {
    const rect = { x: candidate.x, y: candidate.y, w: size.w, h: size.h };
    const inside = rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= viewport.w && rect.y + rect.h <= viewport.h;
    if (inside && !blocked.some((block) => intersects(rect, block))) return candidate;
  }
  return corner;
}

/** What she says the first time after signing in. */
export const INTRO: Speech = { pose: "cheer", text: "Hare Krishna! I'm Rachna, your creative companion. How can I help you today?" };

/** The live counts behind her quests and her mood, gathered by the app layout for every page. */
export type QuestCounts = { replies: number; parcels: number; approvals: number; todaySent: number; dailyTarget: number; hot: number };
export type RachnaCounts = QuestCounts & { due: number; lateMax: number };

export type Quest = { key: "hot" | "replies" | "messages" | "approvals" | "parcels"; label: string; done: number; total: number; href: string };

/**
 * The day's quests. The three queues run until empty, measured against where
 * they stood when the day began (so answering two of three replies shows as
 * two of three); a queue that grew keeps an honest total. Messages count up
 * to the daily target. A queue that was empty all day is not a quest.
 */
export const QUEST_CAP = 10;

export function questsFor(now: QuestCounts, start: QuestCounts): Quest[] {
  const quests: Quest[] = [];
  const queue = (key: Quest["key"], began: number, current: number, label: (n: number) => string, href: string) => {
    const full = Math.max(began, current);
    if (full === 0) return;
    // 535 waiting replies is a backlog, not a day: the quest is the next ten, with the rest named.
    const total = Math.min(full, QUEST_CAP);
    const done = Math.min(full - current, total);
    quests.push({ key, label: full > total ? `${label(total)} (${full} waiting)` : label(total), done, total, href });
  };
  queue("hot", start.hot ?? 0, now.hot ?? 0, (n) => `Answer ${n} hot ${n === 1 ? "reply" : "replies"}`, "/today?hot=1");
  queue("replies", start.replies, now.replies, (n) => `Reply to ${n} ${n === 1 ? "creator" : "creators"}`, "/today?queue=replies");
  if (now.dailyTarget > 0) quests.push({ key: "messages", label: `Send ${now.dailyTarget} messages`, done: Math.min(now.todaySent, now.dailyTarget), total: now.dailyTarget, href: "/today#tasks-card" });
  queue("approvals", start.approvals, now.approvals, (n) => `Approve ${n} ${n === 1 ? "gift" : "gifts"}`, "/orders?status=needs_approval");
  queue("parcels", start.parcels, now.parcels, (n) => `Check ${n} ${n === 1 ? "parcel" : "parcels"}`, "/today?queue=delivery");
  return quests;
}

export function dayCleared(quests: Quest[]): boolean {
  return quests.length > 0 && quests.every((quest) => quest.done >= quest.total);
}

/** How much of the day is done, 0 to 1, by items rather than by quest so the ring moves with every step. */
export function questProgress(quests: Quest[]): number {
  const total = quests.reduce((sum, quest) => sum + quest.total, 0);
  return total === 0 ? 0 : quests.reduce((sum, quest) => sum + quest.done, 0) / total;
}

export type Mood = "idle" | "happy" | "worried";

/** Her face when she is not talking: worried once anything is three days late, happy with an empty list. */
export function moodFor(counts: { due: number; lateMax: number }): Mood {
  if (counts.lateMax >= 3) return "worried";
  if (counts.due === 0) return "happy";
  return "idle";
}

export type PickCandidate = { queue: string; lateDays: number; followers: number | null; name: string; warmth?: Warmth | null };

const PICK_ORDER = ["replies", "gifts", "selection", "first", "followups", "delivery", "content", "posted", "review"];

/** Her one creator to act on first: a reply beats everything, then a gift to approve, then the queues in order; hot before warm before cold, late first, then the bigger audience. */
export function pickFor<T extends PickCandidate>(rows: T[]): T | null {
  const rank = (queue: string) => {
    const index = PICK_ORDER.indexOf(queue);
    return index === -1 ? PICK_ORDER.length : index;
  };
  return [...rows].sort((a, b) => rank(a.queue) - rank(b.queue) || warmthRank(a.warmth) - warmthRank(b.warmth) || b.lateDays - a.lateDays || (b.followers ?? 0) - (a.followers ?? 0) || a.name.localeCompare(b.name))[0] ?? null;
}

const REASONS: Record<string, string> = {
  replies: "Replied, waiting for you",
  gifts: "Gift waiting for approval",
  selection: "Agreed, needs the product link",
  first: "First message due",
  followups: "Follow-up due",
  delivery: "Parcel to check",
  content: "Content to chase",
  posted: "Post to check",
  review: "Waiting for review",
};

export function pickReason(row: { queue: string; lateDays: number; warmth?: Warmth | null }): string {
  const base = row.warmth === "hot" && row.queue === "replies" ? "Hot reply, waiting for you" : (REASONS[row.queue] ?? "Needs you");
  return row.lateDays > 0 ? `${base} · ${row.lateDays === 1 ? "1 day" : `${row.lateDays} days`} late` : base;
}
