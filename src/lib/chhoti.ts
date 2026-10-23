import type { CreatorStatus } from "@prisma/client";

/**
 * Chhoti, the guide: the rules behind her, kept free of the browser so they
 * can be tested. She greets once a day, nudges once per creator per session,
 * cheers a few milestones, naps after ten quiet minutes, and never covers a
 * button or a field. When tips are off only the "?" tour remains.
 */
export type ChhotiPose = "idle" | "point" | "cheer" | "think" | "sleep";
export type TipKind = "greeting" | "nudge" | "milestone" | "tour";

export const IDLE_MS = 10 * 60 * 1000;
export const CONFETTI_MS = 1000;

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
  return `cge:chhoti:${userId}:${part}`;
}

export type Speech = { pose: ChhotiPose; text: string; action?: { label: string; href: string } };

/** The morning note, built from the real counts. A count of zero drops its clause. */
export function greetingFor(name: string, counts: { replies: number; parcels: number; total: number }): Speech {
  if (counts.total === 0) return { pose: "think", text: "Nothing due today. Go find two new creators?", action: { label: "Check a profile", href: "/influencers/new" } };
  const parts: string[] = [];
  if (counts.replies > 0) parts.push(`${counts.replies} ${counts.replies === 1 ? "reply" : "replies"} first`);
  if (counts.parcels > 0) parts.push(`${counts.parcels} parcel ${counts.parcels === 1 ? "check" : "checks"}`);
  if (parts.length === 0) parts.push(`${counts.total} ${counts.total === 1 ? "thing" : "things"} on the list`);
  const joined = parts.length === 2 ? `${parts[0]}, then ${parts[1]}` : parts[0];
  return { pose: "point", text: `Morning, ${name}! ${joined.charAt(0).toUpperCase()}${joined.slice(1)}.` };
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
