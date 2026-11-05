/**
 * The Review queue's creator insights, pure and tested. Two kinds of number,
 * kept apart on purpose:
 *
 *   public activity  counted from the public posts we hold (ProfilePost): posts,
 *                    likes, comments and views in the last 7 and 30 days and week
 *                    by week. Likes, comments and views are the platform's running
 *                    totals on posts from that period, not gains within it.
 *   supplied         reach, profile views and US audience the creator sent us
 *                    about their own account (CreatorInsight). Instagram and
 *                    YouTube keep these private to the account owner.
 *
 * Nothing here reads the database.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many recent posts a fetch reads per account (Instagram 25, YouTube 30). Reaching it means older posts may exist. */
export const FETCH_LIMIT: Record<string, number> = { instagram: 25, youtube: 30 };

export type PostPoint = {
  postedAt: Date;
  views: number | null;
  likes: number | null;
  comments: number | null;
  capturedAt: Date;
};

export type PeriodTotals = {
  /** Window start (exclusive) and end (inclusive). */
  from: Date;
  to: Date;
  posts: number;
  /** Null when no post in the window reported the number (hidden likes, no view count). */
  likes: number | null;
  comments: number | null;
  views: number | null;
  avgLikes: number | null;
  avgComments: number | null;
  avgViews: number | null;
};

export type ActivitySummary = {
  /** When the newest reading was taken. */
  asOf: Date;
  postsHeld: number;
  days7: PeriodTotals;
  days30: PeriodTotals;
  /** Four weeks, newest first: the last 7 days, the 7 before, and so on. */
  weeks: PeriodTotals[];
  /** The fetch hit its limit and every post it got is inside the 30 days: there may be more posts than are counted. */
  mayBeIncomplete: boolean;
};

const sum = (values: (number | null)[]): { total: number | null; known: number } => {
  const known = values.filter((value): value is number => value !== null);
  return { total: known.length > 0 ? known.reduce((all, value) => all + value, 0) : null, known: known.length };
};
const average = (total: number | null, known: number) => (total === null || known === 0 ? null : Math.round(total / known));

function totalsFor(posts: PostPoint[], from: Date, to: Date): PeriodTotals {
  const inside = posts.filter((post) => post.postedAt.getTime() > from.getTime() && post.postedAt.getTime() <= to.getTime());
  const likes = sum(inside.map((post) => post.likes));
  const comments = sum(inside.map((post) => post.comments));
  const views = sum(inside.map((post) => post.views));
  return {
    from,
    to,
    posts: inside.length,
    likes: likes.total,
    comments: comments.total,
    views: views.total,
    avgLikes: average(likes.total, likes.known),
    avgComments: average(comments.total, comments.known),
    avgViews: average(views.total, views.known),
  };
}

/** Insights counted from the public posts held for one profile. Null when none are held. */
export function summariseActivity(posts: PostPoint[], now: Date, fetchLimit = 25): ActivitySummary | null {
  if (posts.length === 0) return null;
  const at = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const oldest = Math.min(...posts.map((post) => post.postedAt.getTime()));
  return {
    asOf: new Date(Math.max(...posts.map((post) => post.capturedAt.getTime()))),
    postsHeld: posts.length,
    days7: totalsFor(posts, at(7), now),
    days30: totalsFor(posts, at(30), now),
    weeks: [0, 1, 2, 3].map((week) => totalsFor(posts, at(7 * (week + 1)), at(7 * week))),
    mayBeIncomplete: posts.length >= fetchLimit && oldest > at(30).getTime(),
  };
}

export type SuppliedInsight = {
  id: string;
  reach7d: number | null;
  reach30d: number | null;
  profileViews30d: number | null;
  usAudiencePct: number | null;
  evidence: string | null;
  note: string | null;
  /** The date the creator's figures are for. */
  asOf: Date;
  addedBy: string;
  createdAt: Date;
};

export type SuppliedInput = {
  reach7d: number | null;
  reach30d: number | null;
  profileViews30d: number | null;
  usAudiencePct: number | null;
  evidence: string | null;
  note: string | null;
  asOf: Date;
};

const MAX_COUNT = 2_000_000_000;

/** "12,400" -> 12400, "12.4k" -> 12400, "1.2m" -> 1200000. Null for an empty cell; undefined when it is not a number. */
function parseCount(raw: string): number | null | undefined {
  const text = raw.trim().replace(/[\s,]/g, "").replace(/%$/, "");
  if (!text) return null;
  const match = /^(\d+(?:\.\d+)?)([km])?$/i.exec(text);
  if (!match) return undefined;
  const value = Math.round(Number(match[1]) * (match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1));
  return value <= MAX_COUNT ? value : undefined;
}

const FIELD_LABELS = { reach7d: "Reached, 7 days", reach30d: "Reached, 30 days", profileViews30d: "Profile views, 30 days", usAudiencePct: "US audience" } as const;

/**
 * Checks what a person typed from a creator's screenshot or media kit. At least
 * one number is needed, the US audience is a whole percent, and the date the
 * figures are for must be a real date that is not in the future.
 */
export function parseSuppliedInsight(input: Record<"reach7d" | "reach30d" | "profileViews30d" | "usAudiencePct" | "evidence" | "note" | "asOf", string>, now: Date): { ok: true; value: SuppliedInput } | { ok: false; error: string } {
  const numbers: Record<keyof typeof FIELD_LABELS, number | null> = { reach7d: null, reach30d: null, profileViews30d: null, usAudiencePct: null };
  for (const name of Object.keys(FIELD_LABELS) as (keyof typeof FIELD_LABELS)[]) {
    const parsed = parseCount(input[name]);
    if (parsed === undefined) return { ok: false, error: `${FIELD_LABELS[name]}: use a whole number, like 12400 or 12.4k.` };
    numbers[name] = parsed;
  }
  if (numbers.usAudiencePct !== null && numbers.usAudiencePct > 100) return { ok: false, error: "US audience: a percent from 0 to 100." };
  if (Object.values(numbers).every((value) => value === null)) return { ok: false, error: "Enter at least one number." };

  const asOfText = input.asOf.trim();
  const asOf = /^\d{4}-\d{2}-\d{2}$/.test(asOfText) ? new Date(`${asOfText}T00:00:00Z`) : null;
  if (!asOf || Number.isNaN(asOf.getTime()) || asOf.toISOString().slice(0, 10) !== asOfText) return { ok: false, error: "Choose the date the creator's figures are for." };
  if (asOf.getTime() > now.getTime() + DAY_MS) return { ok: false, error: "That date is in the future." };

  const evidence = input.evidence.trim().slice(0, 120) || null;
  const note = input.note.trim().slice(0, 500) || null;
  return { ok: true, value: { ...numbers, evidence, note, asOf } };
}
