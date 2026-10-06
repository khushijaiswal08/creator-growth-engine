import type { DataSource, Platform } from "@prisma/client";
import { normalizeHandle } from "@/lib/profile-url";
import type { ProfileData } from "../types";

/** A profile with nothing known beyond its platform and handle. */
export function bareProfile(source: DataSource, platform: Platform, handle: string): ProfileData {
  const normalized = normalizeHandle(platform, handle);
  if (!normalized) throw new Error(`"${handle}" is not a valid ${platform} handle.`);
  return {
    platform,
    handle: normalized,
    name: null,
    email: null,
    location: null,
    followers: null,
    engagementRate: null,
    bio: null,
    website: null,
    country: null,
    lastPostAt: null,
    lastPostUrl: null,
    recentCaptions: [],
    fetchNote: null,
    fetchedAt: null,
    source,
  };
}

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

/** An email address literally written in a bio or description. Never guessed. */
export function emailInText(text: string | null | undefined): string | null {
  const match = text ? EMAIL_IN_TEXT.exec(text) : null;
  return match ? match[0].toLowerCase() : null;
}

/** True when the text contains any of the negative keywords as a whole phrase. */
export function matchesNegative(text: string, negativeKeywords: string[]): boolean {
  const haystack = text.toLowerCase();
  return negativeKeywords.some((keyword) => keyword && haystack.includes(keyword.toLowerCase()));
}

export function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Runs `worker` over `items` with at most `limit` in flight. Stops handing out work once `shouldStop()` is true. */
export async function mapLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  let next = 0;
  const run = async () => {
    while (next < items.length && !shouldStop()) {
      const item = items[next++];
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}
