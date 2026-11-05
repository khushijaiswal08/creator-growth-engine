import type { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { FETCH_LIMIT, summariseActivity, type ActivitySummary, type SuppliedInsight } from "@/lib/creator-insights";

export type ProfileInsights = { profileId: string; activity: ActivitySummary | null; supplied: SuppliedInsight | null };

const CHUNK = 200;

/**
 * Insights for the given profiles: public activity counted from the posts held,
 * and the newest numbers a creator supplied. The caller has already limited
 * the profiles to creators the person may see (the review queue does).
 */
export async function loadProfileInsights(profiles: { id: string; platform: Platform }[], now = new Date()): Promise<Map<string, ProfileInsights>> {
  const result = new Map<string, ProfileInsights>();
  for (let start = 0; start < profiles.length; start += CHUNK) {
    const chunk = profiles.slice(start, start + CHUNK);
    const ids = chunk.map((profile) => profile.id);
    const [posts, supplied] = await Promise.all([
      db.profilePost.findMany({ where: { socialProfileId: { in: ids } }, select: { socialProfileId: true, postedAt: true, views: true, likes: true, comments: true, capturedAt: true } }),
      db.creatorInsight.findMany({
        where: { socialProfileId: { in: ids } },
        orderBy: [{ asOf: "desc" }, { createdAt: "desc" }],
        select: { id: true, socialProfileId: true, reach7d: true, reach30d: true, profileViews30d: true, usAudiencePct: true, evidence: true, note: true, asOf: true, createdAt: true, addedBy: { select: { name: true } } },
      }),
    ]);
    const postsBy = new Map<string, typeof posts>();
    for (const post of posts) postsBy.set(post.socialProfileId, [...(postsBy.get(post.socialProfileId) ?? []), post]);
    const newest = new Map<string, SuppliedInsight>();
    for (const row of supplied) {
      if (newest.has(row.socialProfileId)) continue;
      const { socialProfileId, addedBy, ...rest } = row;
      void socialProfileId;
      newest.set(row.socialProfileId, { ...rest, addedBy: addedBy.name });
    }
    for (const profile of chunk) {
      result.set(profile.id, {
        profileId: profile.id,
        activity: summariseActivity(postsBy.get(profile.id) ?? [], now, FETCH_LIMIT[profile.platform] ?? 25),
        supplied: newest.get(profile.id) ?? null,
      });
    }
  }
  return result;
}
