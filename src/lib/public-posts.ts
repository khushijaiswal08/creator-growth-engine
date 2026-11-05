import type { Prisma } from "@prisma/client";
import type { BrandScope } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import type { PublicPost } from "@/lib/fetching/types";
import { lookupYoutubeChannel } from "@/lib/fetching/adapters/youtube";
import { lookupInstagramAccount } from "@/lib/fetching/adapters/meta-free";
import { displayHandle, PLATFORM_LABELS } from "@/lib/profile-url";

/**
 * The public posts of a profile, kept for the Review queue's insights. Discovery
 * writes them when it finds a creator; "Refresh public numbers" writes them
 * again for a creator already in the portal. Only what the platform shows
 * anyone is stored here.
 */

/** Rows for a profile's posts, ready for createMany. Two readings of the same post keep the later one. */
export function profilePostRows(socialProfileId: string, posts: PublicPost[], capturedAt: Date): Prisma.ProfilePostCreateManyInput[] {
  const byId = new Map(posts.map((post) => [post.externalId, post]));
  return [...byId.values()].map((post) => ({
    socialProfileId,
    externalId: post.externalId,
    url: post.url,
    kind: post.kind,
    postedAt: post.postedAt,
    views: post.views,
    likes: post.likes,
    comments: post.comments,
    capturedAt,
  }));
}

/** Saves a fresh reading: posts not seen before are added, posts already held get their numbers updated. Nothing is deleted. */
export async function savePublicPosts(socialProfileId: string, posts: PublicPost[], capturedAt: Date): Promise<{ added: number; updated: number }> {
  const rows = profilePostRows(socialProfileId, posts, capturedAt);
  if (rows.length === 0) return { added: 0, updated: 0 };
  const held = await db.profilePost.findMany({ where: { socialProfileId, externalId: { in: rows.map((row) => row.externalId) } }, select: { id: true, externalId: true } });
  const heldIds = new Map(held.map((post) => [post.externalId, post.id]));
  const fresh = rows.filter((row) => !heldIds.has(row.externalId));
  await db.$transaction([
    db.profilePost.createMany({ data: fresh }),
    ...rows
      .filter((row) => heldIds.has(row.externalId))
      .map((row) => db.profilePost.update({ where: { id: heldIds.get(row.externalId)! }, data: { url: row.url, kind: row.kind, views: row.views, likes: row.likes, comments: row.comments, capturedAt }, select: { id: true } })),
  ]);
  return { added: fresh.length, updated: rows.length - fresh.length };
}

export type RefreshResult = { ok: true; message: string } | { ok: false; error: string };

/**
 * Looks one profile up again on its platform and keeps the public posts it
 * shows now. Instagram goes through Business Discovery (professional accounts
 * only) and YouTube through the Data API; TikTok has no source yet. The
 * profile must belong to a creator inside the person's brand scope.
 */
export async function refreshPublicPosts(profileId: string, scope: BrandScope): Promise<RefreshResult> {
  const profile = await db.socialProfile.findFirst({ where: { id: profileId, influencer: scope.influencers }, select: { id: true, platform: true, handle: true } });
  if (!profile) return { ok: false, error: "That profile is not one you can open." };
  const label = `${PLATFORM_LABELS[profile.platform]} ${displayHandle(profile.handle)}`;

  let candidate: Awaited<ReturnType<typeof lookupInstagramAccount>>["candidate"];
  if (profile.platform === "instagram") {
    const result = await lookupInstagramAccount(profile.handle, null);
    if (result.statsFound === null) return { ok: false, error: "Instagram is not connected yet (the Meta key is missing), so nothing could be fetched." };
    if (!result.statsFound) return { ok: false, error: `${label} is not a professional account, so Instagram shares no public numbers for it. Ask the creator for a screenshot instead.` };
    candidate = result.candidate;
  } else if (profile.platform === "youtube") {
    let result: Awaited<ReturnType<typeof lookupYoutubeChannel>>;
    try {
      result = await lookupYoutubeChannel(profile.handle);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "YouTube could not be reached." };
    }
    if (result.found === null) return { ok: false, error: "YouTube is not connected yet (the API key is missing), so nothing could be fetched." };
    if (!result.found) return { ok: false, error: result.candidate.fetchNote ?? `No YouTube channel was found for ${label}.` };
    candidate = result.candidate;
  } else {
    return { ok: false, error: `${PLATFORM_LABELS[profile.platform]} public numbers cannot be fetched yet. Use the creator's own screenshot.` };
  }

  const now = new Date();
  const { added, updated } = await savePublicPosts(profile.id, candidate.recentPosts, now);
  await db.socialProfile.update({
    where: { id: profile.id },
    data: {
      lastFetchedAt: now,
      fetchNote: candidate.fetchNote,
      ...(candidate.followers !== null ? { followers: candidate.followers } : {}),
      ...(candidate.engagementRate !== null ? { engagementRate: candidate.engagementRate } : {}),
      ...(candidate.lastPostAt ? { lastPostAt: candidate.lastPostAt, lastPostUrl: candidate.lastPostUrl } : {}),
    },
    select: { id: true },
  });
  return { ok: true, message: candidate.recentPosts.length === 0 ? `${label} has no public posts to read.` : `${label}: ${added} new and ${updated} updated posts.` };
}
