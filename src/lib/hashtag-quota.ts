import { db } from "@/lib/db";

/**
 * Instagram lets one business account query at most 30 unique hashtags in any
 * rolling 7 days. A tag already queried inside the window can be queried again
 * for free. We enforce the rule ourselves so a run can never trip it.
 */
export const HASHTAG_LIMIT = 30;
export const HASHTAG_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** "Home Decor!" -> "homedecor". Returns null when nothing usable is left. */
export function toHashtag(keyword: string): string | null {
  const tag = keyword
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9_]/g, "");
  return tag.length >= 2 && tag.length <= 60 ? tag : null;
}

export type HashtagBudget = { used: number; remaining: number; activeTags: string[] };

export async function hashtagBudget(now = new Date()): Promise<HashtagBudget> {
  const active = await db.hashtag.findMany({
    where: { firstUsedAt: { gt: new Date(now.getTime() - HASHTAG_WINDOW_MS) } },
    select: { tag: true },
    orderBy: { firstUsedAt: "asc" },
  });
  return {
    used: active.length,
    remaining: Math.max(0, HASHTAG_LIMIT - active.length),
    activeTags: active.map((row) => row.tag),
  };
}

export type HashtagReservation = { ok: true; counted: boolean } | { ok: false; reason: string };

/**
 * Call before querying a hashtag. Refuses a tag that would be the 31st unique
 * one in the window; otherwise records it (or leaves an in-window tag as is).
 */
export async function reserveHashtag(tag: string, now = new Date()): Promise<HashtagReservation> {
  const windowStart = new Date(now.getTime() - HASHTAG_WINDOW_MS);

  return db.$transaction(async (tx) => {
    const existing = await tx.hashtag.findUnique({ where: { tag } });
    if (existing && existing.firstUsedAt > windowStart) return { ok: true as const, counted: false };

    const used = await tx.hashtag.count({ where: { firstUsedAt: { gt: windowStart } } });
    if (used >= HASHTAG_LIMIT) {
      return {
        ok: false as const,
        reason: `#${tag} was not searched: ${HASHTAG_LIMIT} different hashtags have already been used in the last 7 days.`,
      };
    }

    // An expired tag starts a new window; a new tag gets its first one.
    await tx.hashtag.upsert({ where: { tag }, update: { firstUsedAt: now }, create: { tag, firstUsedAt: now } });
    return { ok: true as const, counted: true };
  });
}
