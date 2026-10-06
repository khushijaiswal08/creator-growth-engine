import { reserveHashtag, toHashtag } from "@/lib/hashtag-quota";
import { normalizeHandle } from "@/lib/profile-url";
import type { Candidate, CreatorSource, DiscoveryResult } from "../types";
import { bareProfile, clip, emailInText, matchesNegative } from "./shared";

/**
 * Instagram discovery on Meta's free APIs, in three steps:
 *
 *   1. Hashtag Search  -> top posts for a hashtag (no author on the post)
 *   2. oEmbed          -> who posted it
 *   3. Business Discovery -> that account's public stats
 *
 * Needs META_ACCESS_TOKEN and IG_BUSINESS_ID (server-side only) and an app
 * approved for "Instagram Public Content Access".
 *
 * Step 2 is the weak link. Since 3 November 2025 Meta's oEmbed response no
 * longer has `author_name`. We still read it if present, and otherwise look
 * for the handle inside the embed HTML. Posts whose author cannot be read are
 * counted and reported; they cannot become candidates.
 */
const MAX_TAGS_PER_RUN = 5;
const POSTS_PER_TAG = 25;
const DEFAULT_CANDIDATE_LIMIT = 60;

// Graph error codes: https://developers.facebook.com/docs/graph-api/guides/error-handling
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002]);
const TOKEN_CODE = 190;

class RateLimited extends Error {}
class TokenInvalid extends Error {}
class GraphError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly subcode: number | undefined,
  ) {
    super(message);
  }
}

type GraphErrorBody = { error?: { message?: string; code?: number; error_subcode?: number } };

type HashtagSearch = { data?: { id: string }[] };

type HashtagMedia = {
  data?: { id: string; caption?: string; permalink?: string; timestamp?: string }[];
};

type OEmbed = { author_name?: string; html?: string };

type BusinessDiscovery = {
  business_discovery?: {
    username?: string;
    name?: string;
    biography?: string;
    website?: string;
    followers_count?: number;
    media?: {
      data?: { caption?: string; permalink?: string; timestamp?: string; like_count?: number; comments_count?: number }[];
    };
  };
};

function graphBase(): string {
  // META_GRAPH_BASE_URL exists so tests can point the adapter at a recorded-response server.
  const base = process.env.META_GRAPH_BASE_URL?.trim() || "https://graph.facebook.com";
  const version = process.env.META_GRAPH_VERSION?.trim();
  return version ? `${base}/${version}` : base;
}

/** The author's handle from an oEmbed response, or null when Meta does not reveal it. */
export function authorFromOEmbed(embed: OEmbed): string | null {
  if (embed.author_name) return normalizeHandle("instagram", embed.author_name);
  const html = embed.html ?? "";
  const match =
    /\(@([A-Za-z0-9._]{1,30})\)/.exec(html) ??
    /instagram\.com\/([A-Za-z0-9._]{1,30})\/?\?utm_source=ig_embed/.exec(html);
  if (!match || /^(p|reel|reels|tv)$/i.test(match[1])) return null;
  return normalizeHandle("instagram", match[1]);
}

async function discover(brief: Parameters<NonNullable<CreatorSource["discover"]>>[0]): Promise<DiscoveryResult> {
  const token = process.env.META_ACCESS_TOKEN?.trim();
  const businessId = process.env.IG_BUSINESS_ID?.trim();
  if (!token || !businessId) {
    const missing = [!token && "META_ACCESS_TOKEN", !businessId && "IG_BUSINESS_ID"].filter(Boolean).join(" and ");
    return {
      candidates: [],
      status: "not_configured",
      quotaUsed: 0,
      skipped: 0,
      note: `Instagram discovery is not configured: ${missing} missing.`,
    };
  }

  let calls = 0;
  const call = async <T>(path: string, params: Record<string, string>): Promise<T> => {
    const url = new URL(`${graphBase()}/${path}`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    calls += 1;
    // The token travels in a header, never in the URL, so it cannot end up in logs.
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    if (response.ok) return (await response.json()) as T;

    const body = (await response.json().catch(() => ({}))) as GraphErrorBody;
    const code = body.error?.code;
    if (code !== undefined && RATE_LIMIT_CODES.has(code)) throw new RateLimited(body.error?.message);
    if (code === TOKEN_CODE) throw new TokenInvalid(body.error?.message);
    throw new GraphError(body.error?.message ?? `Graph ${path} failed (${response.status})`, code, body.error?.error_subcode);
  };

  const negatives = (brief.negativeKeywords ?? []).filter(Boolean);
  const tags = [...new Set((brief.nicheKeywords ?? []).flatMap((keyword) => toHashtag(keyword) ?? []))].slice(
    0,
    MAX_TAGS_PER_RUN,
  );
  if (tags.length === 0) {
    return {
      candidates: [],
      status: "failed",
      quotaUsed: 0,
      skipped: 0,
      note: "The campaign has no niche keywords that can be used as hashtags.",
    };
  }

  const candidates: Candidate[] = [];
  const notes: string[] = [];
  let skipped = 0;
  let unattributed = 0;
  let status: DiscoveryResult["status"] = "completed";

  try {
    // 1. Hashtag search, within the 30-per-7-days rule.
    const posts = new Map<string, { caption: string; timestamp: string | null }>();
    for (const tag of tags) {
      const reservation = await reserveHashtag(tag);
      if (!reservation.ok) {
        notes.push(reservation.reason);
        continue;
      }
      const search = await call<HashtagSearch>("ig_hashtag_search", { user_id: businessId, q: tag });
      const hashtagId = search.data?.[0]?.id;
      if (!hashtagId) continue;

      const media = await call<HashtagMedia>(`${hashtagId}/top_media`, {
        user_id: businessId,
        fields: "id,caption,permalink,timestamp",
        limit: String(POSTS_PER_TAG),
      });
      for (const post of media.data ?? []) {
        if (!post.permalink) continue;
        if (matchesNegative(post.caption ?? "", negatives)) {
          skipped += 1;
          continue;
        }
        posts.set(post.permalink, { caption: post.caption ?? "", timestamp: post.timestamp ?? null });
      }
    }

    // 2. oEmbed: find out who posted each one.
    const byAuthor = new Map<string, { permalink: string; caption: string; timestamp: string | null }>();
    const limit = brief.limit ?? DEFAULT_CANDIDATE_LIMIT;
    for (const [permalink, post] of posts) {
      if (byAuthor.size >= limit) break;
      let author: string | null = null;
      try {
        author = authorFromOEmbed(await call<OEmbed>("instagram_oembed", { url: permalink, omitscript: "true" }));
      } catch (error) {
        if (error instanceof RateLimited || error instanceof TokenInvalid) throw error;
        // A post that cannot be embedded (deleted, private) is just skipped.
      }
      if (!author) {
        unattributed += 1;
        continue;
      }
      if (!byAuthor.has(author)) byAuthor.set(author, { permalink, ...post });
    }

    // 3. Business Discovery: public stats for each author.
    for (const [handle, post] of byAuthor) {
      const candidate: Candidate = {
        ...bareProfile("meta_free", "instagram", handle),
        lastPostAt: post.timestamp ? new Date(post.timestamp) : null,
        lastPostUrl: post.permalink,
        recentCaptions: post.caption ? [clip(post.caption, 300)] : [],
        fetchedAt: new Date(),
      };

      try {
        const fields = `business_discovery.username(${handle}){username,name,biography,website,followers_count,media.limit(5){caption,permalink,timestamp,like_count,comments_count}}`;
        const found = (await call<BusinessDiscovery>(businessId, { fields })).business_discovery;
        if (found) {
          const media = found.media?.data ?? [];
          candidate.name = found.name ?? null;
          candidate.bio = found.biography ? clip(found.biography, 1000) : null;
          candidate.website = found.website ?? null;
          candidate.email = emailInText(found.biography);
          candidate.followers = found.followers_count ?? null;
          if (media.length > 0) {
            candidate.recentCaptions = media.flatMap((item) => (item.caption ? [clip(item.caption, 300)] : []));
            candidate.lastPostAt = media[0].timestamp ? new Date(media[0].timestamp) : candidate.lastPostAt;
            candidate.lastPostUrl = media[0].permalink ?? candidate.lastPostUrl;
            const counted = media.filter((item) => item.like_count !== undefined);
            if (candidate.followers && counted.length > 0) {
              const interactions = counted.reduce(
                (sum, item) => sum + (item.like_count ?? 0) + (item.comments_count ?? 0),
                0,
              );
              candidate.engagementRate = Number(((interactions / counted.length / candidate.followers) * 100).toFixed(2));
            }
          }
        }
      } catch (error) {
        if (error instanceof RateLimited || error instanceof TokenInvalid) throw error;
        // Business Discovery only works for professional (business or creator)
        // accounts. Anything else is recorded without stats rather than lost.
        candidate.fetchNote = "Not a professional account; stats unavailable.";
      }

      candidates.push(candidate);
    }

    if (unattributed > 0) {
      notes.push(
        `${unattributed} posts could not be matched to an account: Meta's oEmbed no longer names the author (changed 3 November 2025).`,
      );
    }
  } catch (error) {
    if (error instanceof RateLimited) {
      status = "stopped_quota";
      notes.push("Meta's rate limit was reached. Accounts found so far were kept; try again in an hour.");
    } else if (error instanceof TokenInvalid) {
      status = "failed";
      notes.push("META_ACCESS_TOKEN is expired or invalid. Generate a new long-lived token.");
    } else {
      status = "failed";
      notes.push(error instanceof Error ? error.message : "Instagram discovery failed.");
    }
  }

  return { candidates, status, quotaUsed: calls, skipped: skipped + unattributed, note: notes.join(" ") || null };
}

export const metaFreeSource: CreatorSource = {
  name: "meta_free",

  discover,

  async fetchCandidates(brief) {
    const result = await discover(brief);
    if (result.status === "not_configured" || result.status === "failed") {
      throw new Error(result.note ?? "Instagram discovery failed.");
    }
    return result.candidates;
  },

  async enrichProfile(platform, handle) {
    return bareProfile("meta_free", platform, handle);
  },
};
