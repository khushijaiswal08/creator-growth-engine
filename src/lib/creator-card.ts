import type { StatusTone } from "@/lib/status";

/**
 * The creator card's rules, pure and tested: Rachna's grade for a creator
 * from their history with us, her verdict in her own words, and the figures
 * the card shows. The numbers come from what the portal has recorded: gifts,
 * posts, the latest views/likes/clicks/sales logged on each post, and the
 * Amazon Creator Connections fields. Nothing here reads a database.
 */

export type CreatorStats = {
  firstName: string;
  gifts: number;
  /** Amazon price of the gifted products, summed, in US dollars. */
  giftValueUsd: number;
  posts: number;
  /** Collaborations where content arrived. */
  delivered: number;
  /** Collaborations closed because the content never came. */
  noContent: number;
  /** Gifts still open: shipped, delivered or waiting for content. */
  pending: number;
  /** Latest views across the posts, summed. */
  reach: number;
  /** Latest likes + comments + shares across the posts. */
  engagements: number;
  clicks: number;
  salesUsd: number;
  followers: number;
  fitScore: number | null;
  lastGiftAt: Date | null;
  lastPostAt: Date | null;
  amazonTier: string | null;
};

export type Grade = "star" | "good" | "mixed" | "waiting" | "risky" | "new";

export const GRADES: Record<Grade, { label: string; tone: StatusTone }> = {
  star: { label: "Star", tone: "success" },
  good: { label: "Good bet", tone: "primary" },
  mixed: { label: "Hit and miss", tone: "warning" },
  waiting: { label: "Gift landed, waiting", tone: "info" },
  risky: { label: "Took the gift, no post", tone: "danger" },
  new: { label: "New face", tone: "neutral" },
};

const DAY = 24 * 60 * 60 * 1000;
/** Days after the last gift before "waiting" turns into a chase. */
export const PATIENCE_DAYS = 21;

/** Posted or no-content outcomes as a share, null before anything finished. */
export function contentRate(s: Pick<CreatorStats, "delivered" | "noContent">): number | null {
  const finished = s.delivered + s.noContent;
  return finished > 0 ? Math.round((s.delivered / finished) * 100) : null;
}

export function reachPerPost(s: Pick<CreatorStats, "reach" | "posts">): number | null {
  return s.posts > 0 && s.reach > 0 ? Math.round(s.reach / s.posts) : null;
}

/** How a post's reach compares with the follower count: 2 means a post reaches twice the followers. */
export function reachMultiple(s: Pick<CreatorStats, "reach" | "posts" | "followers">): number | null {
  const perPost = reachPerPost(s);
  if (perPost === null || s.followers <= 0) return null;
  return Math.round((perPost / s.followers) * 10) / 10;
}

export function engagementRate(s: Pick<CreatorStats, "reach" | "engagements">): number | null {
  return s.reach > 0 ? Math.round((s.engagements / s.reach) * 1000) / 10 : null;
}

/**
 * The grade. Two or more posts with at least 80% of collaborations delivered
 * is a star; one delivery with a decent rate is a good bet; a poor rate is hit
 * and miss. A gift with no post yet is "waiting" until a no-content outcome
 * makes it "risky". Nobody we have gifted is "new".
 */
export function gradeCreator(s: CreatorStats): Grade {
  if (s.gifts === 0 && s.posts === 0) return "new";
  if (s.posts === 0) return s.noContent > 0 ? "risky" : "waiting";
  const rate = contentRate(s) ?? 100;
  if (s.posts >= 2 && rate >= 80) return "star";
  if (rate >= 60) return "good";
  return "mixed";
}

export type Verdict = { grade: Grade; label: string; tone: StatusTone; pose: "cheer" | "point" | "think" | "worried" | "idle" | "happy"; text: string };

const money = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;
const count = (value: number) => (value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 10_000 ? `${Math.round(value / 1000)}K` : value >= 1_000 ? `${(value / 1000).toFixed(1)}K` : String(value));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Rachna's verdict: the grade, her face, and a line in her voice, built only from the figures. */
export function rachnaVerdict(s: CreatorStats, now = new Date()): Verdict {
  const grade = gradeCreator(s);
  const { label, tone } = GRADES[grade];
  const rate = contentRate(s);
  const flourish: string[] = [];
  if (s.salesUsd > 0) flourish.push(`${money(s.salesUsd)} in Amazon sales from their content, real money.`);
  else if (s.clicks > 0) flourish.push(`${plural(s.clicks, "click")} to Amazon so far.`);
  const multiple = reachMultiple(s);
  if (multiple !== null && multiple >= 1.5) flourish.push(`Posts reach ${multiple}× the follower count.`);
  else if (reachPerPost(s) !== null) flourish.push(`About ${count(reachPerPost(s)!)} views a post.`);
  const extra = flourish.length > 0 ? ` ${flourish.join(" ")}` : "";

  switch (grade) {
    case "star":
      return { grade, label, tone, pose: "cheer", text: `Total gem. ${plural(s.posts, "post")} from ${plural(s.gifts, "gift")}${rate !== null ? `, ${rate}% delivered` : ""}. Gift again without a second thought.${extra}` };
    case "good":
      return { grade, label, tone, pose: "happy", text: `Solid. ${plural(s.posts, "post")} from ${plural(s.gifts, "gift")}${rate !== null ? `, ${rate}% delivered` : ""}. Worth another gift.${extra}` };
    case "mixed":
      return { grade, label, tone, pose: "think", text: `Hit and miss. ${plural(s.posts, "post")} from ${plural(s.gifts, "gift")}${rate !== null ? `, only ${rate}% delivered` : ""}. Nudge before the next gift.${extra}` };
    case "waiting": {
      const days = s.lastGiftAt ? Math.max(0, Math.floor((now.getTime() - s.lastGiftAt.getTime()) / DAY)) : null;
      if (days !== null && days > PATIENCE_DAYS) return { grade, label, tone, pose: "worried", text: `Gift landed ${days} days ago and still no post. Time to chase, nicely.` };
      return { grade, label, tone, pose: "point", text: days !== null ? `Gift landed ${days === 0 ? "today" : `${days} days ago`}, no post yet. Give it till day ${PATIENCE_DAYS}, then chase.` : `Gift on its way, no post yet. Give it till day ${PATIENCE_DAYS} after it lands.` };
    }
    case "risky":
      return { grade, label, tone, pose: "worried", text: `Took ${s.noContent === 1 ? "a gift" : plural(s.noContent, "gift")} and never posted. I'd skip the next one unless they explain.` };
    default:
      return {
        grade,
        label,
        tone,
        pose: "idle",
        text: s.fitScore !== null ? `Fresh face, no history with us yet. Fit score ${s.fitScore}; a first gift is the test.${s.amazonTier ? ` They're ${/^[aeiou]/i.test(s.amazonTier) ? "an" : "a"} ${s.amazonTier} creator on Amazon, promising.` : ""}` : `Fresh face, no history with us yet. A first gift is the test.${s.amazonTier ? ` They're on Amazon Creator Connections (${s.amazonTier}), promising.` : ""}`,
      };
  }
}

export type MonthPoint = { month: string; label: string; gifts: number; posts: number; reach: number; salesUsd: number };

/** The last `months` months, oldest first, with each event counted in its month. */
export function monthlySeries(events: { at: Date; kind: "gift" | "post"; reach?: number; salesUsd?: number }[], months = 6, now = new Date()): MonthPoint[] {
  const points: MonthPoint[] = [];
  for (let back = months - 1; back >= 0; back--) {
    const date = new Date(now.getFullYear(), now.getMonth() - back, 1);
    points.push({ month: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`, label: date.toLocaleString("en-US", { month: "short" }), gifts: 0, posts: 0, reach: 0, salesUsd: 0 });
  }
  for (const event of events) {
    const key = `${event.at.getFullYear()}-${String(event.at.getMonth() + 1).padStart(2, "0")}`;
    const point = points.find((item) => item.month === key);
    if (!point) continue;
    if (event.kind === "gift") point.gifts += 1;
    else {
      point.posts += 1;
      point.reach += event.reach ?? 0;
      point.salesUsd += event.salesUsd ?? 0;
    }
  }
  return points;
}
