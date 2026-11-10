import { reserveHashtag, toHashtag } from "@/lib/hashtag-quota";
import { redactSecrets } from "@/lib/meta-graph";
import { normalizeHandle } from "@/lib/profile-url";
import type { Brief, Candidate, CreatorSource, DiscoveryResult, DiscoveryStep, PublicPost } from "../types";
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
 * kept on the run as "pending": a reviewer sees the post, types the handle,
 * and Business Discovery fills the stats (src/lib/discovery.ts, attributePost).
 *
 * Resumable: step 1 is one slice; steps 2 and 3 run POSTS_PER_STEP posts at
 * a time. Every slice records what the live API answered.
 */
const MAX_TAGS_PER_RUN = 5;
const POSTS_PER_TAG = 25;
const POSTS_PER_STEP = 8;
const DEFAULT_CANDIDATE_LIMIT = 60;
const MAX_PENDING = 60;
/** Recent posts read per account for the Review queue's insights (Meta's default page size). */
const MEDIA_LIMIT = 25;

// Graph error codes: https://developers.facebook.com/docs/graph-api/guides/error-handling
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002]);
const TOKEN_CODE = 190;

class RateLimited extends Error {}
class TokenInvalid extends Error {}
class GraphError extends Error {}

type GraphErrorBody = { error?: { message?: string; code?: number; error_subcode?: number } };
type HashtagSearch = { data?: { id: string }[] };
type HashtagMedia = { data?: { id: string; caption?: string; permalink?: string; timestamp?: string }[] };
type OEmbed = { author_name?: string; html?: string };
type BusinessDiscoveryMedia = {
  id?: string;
  caption?: string;
  permalink?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
  media_type?: string;
  /** Views of a reel; public through Business Discovery. */
  view_count?: number;
};
type BusinessDiscovery = {
  business_discovery?: {
    username?: string;
    name?: string;
    biography?: string;
    website?: string;
    followers_count?: number;
    media?: { data?: BusinessDiscoveryMedia[] };
  };
};

export type PendingPost = { permalink: string; caption: string; timestamp: string | null };

export type MetaReport = {
  hashtags: { tag: string; hashtagId: string | null; posts: number; refused?: string }[];
  oembed: { calls: number; withAuthor: number; withoutAuthor: number; failed: number };
  businessDiscovery: { attempted: number; succeeded: number };
  /** Posts still waiting for a reviewer to name the account. */
  pending: PendingPost[];
  /** Posts a reviewer named, and what came of it. */
  attributed: { permalink: string; handle: string; outcome: string; by: string; at: string }[];
};

type Cursor = {
  phase: "authors";
  posts: PendingPost[];
  index: number;
  authors: string[];
  report: MetaReport;
};

function graphBase(): string {
  // META_GRAPH_BASE_URL exists so tests can point the adapter at a recorded-response server.
  const base = process.env.META_GRAPH_BASE_URL?.trim() || "https://graph.facebook.com";
  const version = process.env.META_GRAPH_VERSION?.trim();
  return version ? `${base}/${version}` : base;
}

const metaCredentials = () => ({ token: process.env.META_ACCESS_TOKEN?.trim(), businessId: process.env.IG_BUSINESS_ID?.trim() });

/** The author's handle from an oEmbed response, or null when Meta does not reveal it. */
function authorFromOEmbed(embed: OEmbed): string | null {
  if (embed.author_name) return normalizeHandle("instagram", embed.author_name);
  const html = embed.html ?? "";
  const match = /\(@([A-Za-z0-9._]{1,30})\)/.exec(html) ?? /instagram\.com\/([A-Za-z0-9._]{1,30})\/?\?utm_source=ig_embed/.exec(html);
  if (!match || /^(p|reel|reels|tv)$/i.test(match[1])) return null;
  return normalizeHandle("instagram", match[1]);
}

type Caller = { call: <T>(path: string, params: Record<string, string>) => Promise<T>; calls: () => number };

function makeCaller(token: string): Caller {
  let count = 0;
  return {
    calls: () => count,
    call: async <T>(path: string, params: Record<string, string>): Promise<T> => {
      const url = new URL(`${graphBase()}/${path}`);
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
      count += 1;
      // The token travels in a header, never in the URL, so it cannot end up in logs.
      let response: Response;
      try {
        response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000), cache: "no-store" });
      } catch {
        // A fetch error can quote the request headers (a token with a line break in it does), so its text is never kept.
        throw new GraphError("Meta could not be reached.");
      }
      if (response.ok) return (await response.json()) as T;
      const body = (await response.json().catch(() => ({}))) as GraphErrorBody;
      const code = body.error?.code;
      // Meta's own text is stored as the run note, so anything token-like in it is removed first.
      const said = body.error?.message ? redactSecrets(body.error.message, token) : undefined;
      if (code !== undefined && RATE_LIMIT_CODES.has(code)) throw new RateLimited(said);
      if (code === TOKEN_CODE) throw new TokenInvalid(said);
      throw new GraphError(said ?? `Graph ${path} failed (${response.status})`);
    },
  };
}

const MEDIA_FIELDS = "caption,permalink,timestamp,like_count,comments_count";
const discoveryFields = (handle: string, media: string, limit: number) =>
  `business_discovery.username(${handle}){username,name,biography,website,followers_count,media.limit(${limit}){${media}}}`;
/** Set once Meta turns the richer media fields down, so later accounts go straight to the plain request. */
let richMediaRefused = false;

/**
 * Public stats for one account through Business Discovery, with up to
 * MEDIA_LIMIT recent posts. The richer request also asks for each post's
 * media type and a reel's view count; if Meta refuses those fields the same
 * request without them is sent, so a field Meta renames costs the reel views
 * and nothing else. Null when the account is not professional.
 */
async function businessDiscovery(caller: Caller, businessId: string, handle: string): Promise<BusinessDiscovery["business_discovery"] | null> {
  const read = async (media: string, limit: number) => (await caller.call<BusinessDiscovery>(businessId, { fields: discoveryFields(handle, media, limit) })).business_discovery ?? null;
  try {
    if (!richMediaRefused) {
      try {
        return await read(`${MEDIA_FIELDS},media_type,view_count`, MEDIA_LIMIT);
      } catch (error) {
        if (error instanceof RateLimited || error instanceof TokenInvalid) throw error;
        // Either the account is not professional, or Meta refused the richer fields: the plain request tells which.
        const plain = await read(MEDIA_FIELDS, MEDIA_LIMIT);
        richMediaRefused = true;
        return plain;
      }
    }
    return await read(MEDIA_FIELDS, MEDIA_LIMIT);
  } catch (error) {
    if (error instanceof RateLimited || error instanceof TokenInvalid) throw error;
    // Business Discovery only works for professional (business or creator) accounts.
    return null;
  }
}

const KINDS: Record<string, PublicPost["kind"]> = { IMAGE: "image", VIDEO: "video", CAROUSEL_ALBUM: "carousel" };
const count = (value: number | undefined): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

/** The public posts Business Discovery returned, newest first, with the numbers it reported. */
function postsFrom(media: BusinessDiscoveryMedia[]): PublicPost[] {
  return media.flatMap((item) => {
    const postedAt = item.timestamp ? new Date(item.timestamp) : null;
    if (!item.permalink || !postedAt || Number.isNaN(postedAt.getTime())) return [];
    const code = /instagram\.com\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/.exec(item.permalink)?.[1] ?? item.id ?? item.permalink;
    return [{ externalId: code, url: item.permalink, kind: (item.media_type && KINDS[item.media_type]) || null, postedAt, views: count(item.view_count), likes: count(item.like_count), comments: count(item.comments_count) }];
  });
}

function fillFromDiscovery(candidate: Candidate, found: NonNullable<BusinessDiscovery["business_discovery"]>): void {
  // The captions, latest post and engagement rate keep using the five newest posts, as before; the insights use them all.
  const all = found.media?.data ?? [];
  const media = all.slice(0, 5);
  candidate.recentPosts = postsFrom(all);
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
      const interactions = counted.reduce((sum, item) => sum + (item.like_count ?? 0) + (item.comments_count ?? 0), 0);
      candidate.engagementRate = Number(((interactions / counted.length / candidate.followers) * 100).toFixed(2));
    }
  }
}

const NO_STATS_NOTE = "Not a professional account; stats unavailable.";

/** A bare Instagram candidate, with what the post itself shows. */
function candidateFromPost(handle: string, post: PendingPost | null): Candidate {
  return {
    ...bareProfile("meta_free", "instagram", handle),
    lastPostAt: post?.timestamp ? new Date(post.timestamp) : null,
    lastPostUrl: post?.permalink ?? null,
    recentCaptions: post?.caption ? [clip(post.caption, 300)] : [],
    fetchedAt: new Date(),
  };
}

/**
 * One Instagram account by handle, with stats when Meta is configured and the
 * account is professional. Used when a reviewer names the author of a post.
 */
export async function lookupInstagramAccount(handle: string, post: PendingPost | null): Promise<{ candidate: Candidate; statsFound: boolean | null }> {
  const candidate = candidateFromPost(handle, post);
  const { token, businessId } = metaCredentials();
  if (!token || !businessId) {
    candidate.fetchNote = "Named by a reviewer; Meta is not configured, so stats were not fetched.";
    return { candidate, statsFound: null };
  }
  const found = await businessDiscovery(makeCaller(token), businessId, handle);
  if (found) fillFromDiscovery(candidate, found);
  else candidate.fetchNote = NO_STATS_NOTE;
  return { candidate, statsFound: Boolean(found) };
}

const emptyReport = (): MetaReport => ({
  hashtags: [],
  oembed: { calls: 0, withAuthor: 0, withoutAuthor: 0, failed: 0 },
  businessDiscovery: { attempted: 0, succeeded: 0 },
  pending: [],
  attributed: [],
});

const finished = (status: DiscoveryStep["status"], note: string | null, extra: Partial<DiscoveryStep> = {}): DiscoveryStep => ({
  candidates: [],
  status,
  quotaUsed: 0,
  skipped: 0,
  note,
  cursor: null,
  done: true,
  ...extra,
});

function stopped(error: unknown, report: MetaReport, quotaUsed: number): DiscoveryStep {
  if (error instanceof RateLimited) {
    return finished("stopped_quota", "Meta's rate limit was reached. Accounts found so far were kept; try again in an hour.", { report, quotaUsed });
  }
  if (error instanceof TokenInvalid) {
    return finished("failed", "META_ACCESS_TOKEN is expired or invalid. Generate a new long-lived token.", { report, quotaUsed });
  }
  return finished("failed", error instanceof Error ? error.message : "Instagram discovery failed.", { report, quotaUsed });
}

/** Step 1: hashtag search and top posts, within the 30-per-7-days rule. */
async function hashtagStep(brief: Brief, caller: Caller, businessId: string): Promise<DiscoveryStep> {
  const negatives = (brief.negativeKeywords ?? []).filter(Boolean);
  const tags = [...new Set((brief.nicheKeywords ?? []).flatMap((keyword) => toHashtag(keyword) ?? []))].slice(0, MAX_TAGS_PER_RUN);
  if (tags.length === 0) return finished("failed", "The campaign has no niche keywords that can be used as hashtags.");

  const report = emptyReport();
  const notes: string[] = [];
  const posts = new Map<string, PendingPost>();
  let skipped = 0;
  try {
    for (const tag of tags) {
      const reservation = await reserveHashtag(tag);
      if (!reservation.ok) {
        notes.push(reservation.reason);
        report.hashtags.push({ tag, hashtagId: null, posts: 0, refused: reservation.reason });
        continue;
      }
      const search = await caller.call<HashtagSearch>("ig_hashtag_search", { user_id: businessId, q: tag });
      const hashtagId = search.data?.[0]?.id ?? null;
      if (!hashtagId) {
        report.hashtags.push({ tag, hashtagId: null, posts: 0 });
        continue;
      }
      const media = await caller.call<HashtagMedia>(`${hashtagId}/top_media`, { user_id: businessId, fields: "id,caption,permalink,timestamp", limit: String(POSTS_PER_TAG) });
      let count = 0;
      for (const post of media.data ?? []) {
        if (!post.permalink) continue;
        if (matchesNegative(post.caption ?? "", negatives)) {
          skipped += 1;
          continue;
        }
        posts.set(post.permalink, { permalink: post.permalink, caption: post.caption ?? "", timestamp: post.timestamp ?? null });
        count += 1;
      }
      report.hashtags.push({ tag, hashtagId, posts: count });
    }
  } catch (error) {
    return stopped(error, report, caller.calls());
  }

  const list = [...posts.values()];
  if (list.length === 0) {
    return finished("completed", [...notes, "No posts were found for these hashtags."].join(" "), { report, quotaUsed: caller.calls(), skipped });
  }
  return {
    candidates: [],
    status: "completed",
    quotaUsed: caller.calls(),
    skipped,
    note: notes.join(" ") || null,
    report,
    cursor: { phase: "authors", posts: list, index: 0, authors: [], report } satisfies Cursor,
    done: false,
  };
}

/** Steps 2 and 3 for the next POSTS_PER_STEP posts: who posted it, then their stats. */
async function authorsStep(brief: Brief, cursor: Cursor, caller: Caller, businessId: string): Promise<DiscoveryStep> {
  const limit = brief.limit ?? DEFAULT_CANDIDATE_LIMIT;
  const report = cursor.report;
  const authors = new Set(cursor.authors);
  const slice = cursor.posts.slice(cursor.index, cursor.index + POSTS_PER_STEP);
  const candidates: Candidate[] = [];
  try {
    for (const post of slice) {
      if (authors.size >= limit) break;
      let author: string | null = null;
      report.oembed.calls += 1;
      try {
        author = authorFromOEmbed(await caller.call<OEmbed>("instagram_oembed", { url: post.permalink, omitscript: "true" }));
      } catch (error) {
        if (error instanceof RateLimited || error instanceof TokenInvalid) throw error;
        report.oembed.failed += 1; // deleted or private: just skipped
        continue;
      }
      if (!author) {
        report.oembed.withoutAuthor += 1;
        if (report.pending.length < MAX_PENDING) report.pending.push(post);
        continue;
      }
      report.oembed.withAuthor += 1;
      if (authors.has(author)) continue;
      authors.add(author);

      const candidate = candidateFromPost(author, post);
      report.businessDiscovery.attempted += 1;
      const found = await businessDiscovery(caller, businessId, author);
      if (found) {
        report.businessDiscovery.succeeded += 1;
        fillFromDiscovery(candidate, found);
      } else candidate.fetchNote = NO_STATS_NOTE;
      candidates.push(candidate);
    }
  } catch (error) {
    const stop = stopped(error, report, caller.calls());
    return { ...stop, candidates };
  }

  const index = cursor.index + slice.length;
  const done = index >= cursor.posts.length || authors.size >= limit;
  const note =
    done && report.oembed.withoutAuthor > 0
      ? `${report.oembed.withoutAuthor} posts could not be matched to an account (Meta's oEmbed no longer names the author). ${report.pending.length} are waiting in the review queue for a handle.`
      : null;
  return {
    candidates,
    status: "completed",
    quotaUsed: caller.calls(),
    skipped: 0,
    note,
    report,
    cursor: done ? null : { ...cursor, index, authors: [...authors], report },
    done,
  };
}

async function discoverStep(brief: Brief, cursor: Record<string, unknown> | null): Promise<DiscoveryStep> {
  const { token, businessId } = metaCredentials();
  if (!token || !businessId) {
    const missing = [!token && "META_ACCESS_TOKEN", !businessId && "IG_BUSINESS_ID"].filter(Boolean).join(" and ");
    return finished("not_configured", `Instagram discovery is not configured: ${missing} missing.`);
  }
  const caller = makeCaller(token);
  if (cursor && (cursor as Cursor).phase === "authors") return authorsStep(brief, cursor as Cursor, caller, businessId);
  return hashtagStep(brief, caller, businessId);
}

/** The whole run in one call: what fetchCandidates and the optional CreatorSource.discover use. */
async function discover(brief: Brief): Promise<DiscoveryResult> {
  const candidates: Candidate[] = [];
  let cursor: Record<string, unknown> | null = null;
  let quotaUsed = 0;
  let skipped = 0;
  let status: DiscoveryResult["status"] = "completed";
  const notes: string[] = [];
  let report: DiscoveryResult["report"];
  for (;;) {
    const step = await discoverStep(brief, cursor);
    candidates.push(...step.candidates);
    quotaUsed += step.quotaUsed;
    skipped += step.skipped;
    if (step.status !== "completed") status = step.status;
    if (step.note) notes.push(step.note);
    report = step.report ?? report;
    cursor = step.cursor;
    if (step.done) break;
  }
  return { candidates, status, quotaUsed, skipped, note: notes.join(" ") || null, report };
}

export const metaFreeSource: CreatorSource = {
  name: "meta_free",
  discover,
  discoverStep,

  async fetchCandidates(brief) {
    const result = await discover(brief);
    if (result.status === "not_configured" || result.status === "failed") throw new Error(result.note ?? "Instagram discovery failed.");
    return result.candidates;
  },

  async enrichProfile(platform, handle) {
    return bareProfile("meta_free", platform, handle);
  },
};
