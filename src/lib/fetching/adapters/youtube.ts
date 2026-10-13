import { normalizeHandle } from "@/lib/profile-url";
import type { Brief, Candidate, CreatorSource, DiscoveryResult, DiscoveryStep } from "../types";
import { bareProfile, clip, emailInText, mapLimit, matchesNegative } from "./shared";

/**
 * YouTube Data API v3. The key is read from the server environment only.
 *
 * Quota: the default allowance is 10,000 units a day. search.list costs 100,
 * channels.list and playlistItems.list cost 1 each, so searches are what to
 * ration. A run searches at most MAX_SEARCHES keywords and respects the
 * budget it is given (see src/lib/youtube-quota.ts): a search that would
 * cross it is not made, and the run says so.
 *
 * The work is done in resumable steps so each fits a short request:
 *   step 1  searches + channel details   (≤ 5 × 100 + a few units)
 *   step 2+ latest uploads, UPLOADS_PER_STEP channels at a time
 */
// YOUTUBE_API_BASE_URL exists so tests can point the adapter at a recorded-response server.
const API = process.env.YOUTUBE_API_BASE_URL?.trim() || "https://www.googleapis.com/youtube/v3";
const MAX_SEARCHES = 5;
const RESULTS_PER_SEARCH = 25;
const MAX_CHANNELS = 200;
const UPLOADS_PER_STEP = 40;
const COST = { search: 100, channels: 1, playlistItems: 1 } as const;
const QUOTA_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded"]);

class QuotaExhausted extends Error {}

type YouTubeError = { error?: { message?: string; errors?: { reason?: string }[] } };
type SearchResponse = { items?: { id?: { channelId?: string } }[] };
type ChannelsResponse = {
  items?: {
    id: string;
    snippet?: { title?: string; description?: string; customUrl?: string; country?: string };
    statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean };
    contentDetails?: { relatedPlaylists?: { uploads?: string } };
  }[];
};
type PlaylistItemsResponse = {
  items?: { snippet?: { title?: string; publishedAt?: string }; contentDetails?: { videoId?: string; videoPublishedAt?: string } }[];
};

/** A channel after step 1, carried in the cursor until its uploads are read. */
type PendingChannel = {
  id: string;
  title: string;
  description: string;
  customUrl: string | null;
  country: string | null;
  subscribers: number | null;
  hidden: boolean;
  uploads: string | null;
};

type Cursor = {
  phase: "uploads";
  channels: PendingChannel[];
  index: number;
  report: Report;
};

type Report = {
  searches: { keyword: string; channelIds: number; units: number }[];
  searchesSkippedForBudget: string[];
  channelsFetched: number;
  uploadsRead: number;
  budget: number | null;
};

async function call<T>(path: string, params: Record<string, string>, key: string): Promise<T> {
  const url = new URL(`${API}/${path}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  url.searchParams.set("key", key);

  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), cache: "no-store" });
  if (response.ok) return (await response.json()) as T;

  const body = (await response.json().catch(() => ({}))) as YouTubeError;
  const reason = body.error?.errors?.[0]?.reason ?? "";
  if (response.status === 403 && QUOTA_REASONS.has(reason)) throw new QuotaExhausted(reason);
  throw new Error(`YouTube ${path} failed (${response.status}): ${body.error?.message ?? "unknown error"}`);
}

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

/** Step 1: one channel search per keyword, then channel details. Leaves the channels in the cursor. */
async function searchStep(brief: Brief, key: string): Promise<DiscoveryStep> {
  const keywords = (brief.nicheKeywords ?? []).filter(Boolean).slice(0, MAX_SEARCHES);
  const negatives = (brief.negativeKeywords ?? []).filter(Boolean);
  if (keywords.length === 0) return finished("failed", "The campaign has no niche keywords to search for.");

  const budget = brief.quotaBudget ?? null;
  const report: Report = { searches: [], searchesSkippedForBudget: [], channelsFetched: 0, uploadsRead: 0, budget };
  let quotaUsed = 0;
  let status: DiscoveryStep["status"] = "completed";
  let note: string | null = null;

  try {
    const channelIds = new Set<string>();
    for (const keyword of keywords) {
      // The 80% rule: a search that would take today past the allowance is not made.
      if (budget !== null && quotaUsed + COST.search > budget) {
        report.searchesSkippedForBudget.push(keyword);
        continue;
      }
      const q = [keyword, ...negatives.map((negative) => `-"${negative}"`)].join(" ");
      quotaUsed += COST.search;
      const found = await call<SearchResponse>(
        "search",
        { part: "snippet", type: "channel", q, maxResults: String(RESULTS_PER_SEARCH), regionCode: "US", relevanceLanguage: "en" },
        key,
      );
      let count = 0;
      for (const item of found.items ?? []) {
        if (item.id?.channelId && !channelIds.has(item.id.channelId)) {
          channelIds.add(item.id.channelId);
          count += 1;
        }
      }
      report.searches.push({ keyword, channelIds: count, units: COST.search });
    }
    if (report.searchesSkippedForBudget.length > 0) {
      status = "stopped_quota";
      note = `Stopped at 80% of the YouTube daily quota: ${report.searchesSkippedForBudget.length} of ${keywords.length} keyword searches were not made (${report.searchesSkippedForBudget.join(", ")}). It resets at midnight Pacific Time.`;
    }

    const ids = [...channelIds].slice(0, brief.limit ?? MAX_CHANNELS);
    const channels: PendingChannel[] = [];
    for (let start = 0; start < ids.length; start += 50) {
      if (budget !== null && quotaUsed + COST.channels > budget) break;
      quotaUsed += COST.channels;
      const page = await call<ChannelsResponse>(
        "channels",
        { part: "snippet,statistics,contentDetails", id: ids.slice(start, start + 50).join(","), maxResults: "50" },
        key,
      );
      for (const channel of page.items ?? []) {
        channels.push({
          id: channel.id,
          title: channel.snippet?.title ?? "",
          description: channel.snippet?.description ?? "",
          customUrl: channel.snippet?.customUrl ?? null,
          country: channel.snippet?.country ?? null,
          subscribers:
            channel.statistics?.hiddenSubscriberCount || channel.statistics?.subscriberCount === undefined
              ? null
              : Number(channel.statistics.subscriberCount),
          hidden: Boolean(channel.statistics?.hiddenSubscriberCount),
          uploads: channel.contentDetails?.relatedPlaylists?.uploads ?? null,
        });
      }
    }
    report.channelsFetched = channels.length;

    if (channels.length === 0) return finished(status, note ?? "No channels matched the keywords.", { quotaUsed, report });
    return {
      candidates: [],
      status,
      quotaUsed,
      skipped: 0,
      note,
      report,
      cursor: { phase: "uploads", channels, index: 0, report } satisfies Cursor,
      done: false,
    };
  } catch (error) {
    if (error instanceof QuotaExhausted) {
      return finished("stopped_quota", "The YouTube daily quota is exhausted; it resets at midnight Pacific Time.", { quotaUsed, report });
    }
    return finished("failed", error instanceof Error ? error.message : "YouTube discovery failed.", { quotaUsed, report });
  }
}

/** Step 2+: the latest uploads of the next UPLOADS_PER_STEP channels become candidates. */
async function uploadsStep(brief: Brief, cursor: Cursor, key: string): Promise<DiscoveryStep> {
  const negatives = (brief.negativeKeywords ?? []).filter(Boolean);
  const budget = brief.quotaBudget ?? null;
  const slice = cursor.channels.slice(cursor.index, cursor.index + UPLOADS_PER_STEP);
  const candidates: Candidate[] = [];
  const report = cursor.report;
  let quotaUsed = 0;
  let skipped = 0;
  let quotaHit = false;
  let budgetHit = false;

  await mapLimit(slice, 6, async (channel) => {
    if (matchesNegative(`${channel.title} ${channel.description}`, negatives)) {
      skipped += 1;
      return;
    }
    const handle = (channel.customUrl ? normalizeHandle("youtube", channel.customUrl) : null) ?? `channel/${channel.id}`;
    const candidate: Candidate = {
      ...bareProfile("youtube", "youtube", handle),
      name: channel.title || null,
      bio: channel.description ? clip(channel.description, 1000) : null,
      email: emailInText(channel.description),
      followers: channel.subscribers,
      country: channel.country,
      fetchNote: channel.hidden ? "Subscriber count is hidden by the channel." : null,
      fetchedAt: new Date(),
    };

    if (channel.uploads && !quotaHit && !budgetHit) {
      if (budget !== null && quotaUsed + COST.playlistItems > budget) {
        budgetHit = true;
      } else {
        try {
          quotaUsed += COST.playlistItems;
          const latest = await call<PlaylistItemsResponse>(
            "playlistItems",
            { part: "snippet,contentDetails", playlistId: channel.uploads, maxResults: "5" },
            key,
          );
          const items = latest.items ?? [];
          const newest = items[0];
          const published = newest?.contentDetails?.videoPublishedAt ?? newest?.snippet?.publishedAt;
          candidate.lastPostAt = published ? new Date(published) : null;
          candidate.lastPostUrl = newest?.contentDetails?.videoId ? `https://www.youtube.com/watch?v=${newest.contentDetails.videoId}` : null;
          candidate.recentCaptions = items.flatMap((item) => (item.snippet?.title ? [clip(item.snippet.title, 200)] : []));
          report.uploadsRead += 1;
        } catch (error) {
          if (error instanceof QuotaExhausted) quotaHit = true;
          else candidate.fetchNote = "Recent uploads could not be read.";
        }
      }
    }
    candidates.push(candidate);
  });

  const index = cursor.index + slice.length;
  const done = index >= cursor.channels.length || quotaHit;
  let status: DiscoveryStep["status"] = "completed";
  let note: string | null = null;
  if (quotaHit) {
    status = "stopped_quota";
    note = `The YouTube daily quota ran out while reading recent uploads. ${index} channels were kept, some without their latest upload.`;
  } else if (budgetHit) {
    note = "Stopped reading recent uploads at 80% of the daily quota; channels were kept without their latest upload.";
  }
  return {
    candidates,
    status,
    quotaUsed,
    skipped,
    note,
    report,
    cursor: done ? null : { ...cursor, index, report },
    done,
  };
}

async function discoverStep(brief: Brief, cursor: Record<string, unknown> | null): Promise<DiscoveryStep> {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key) return finished("not_configured", "YouTube is not configured: YOUTUBE_API_KEY is missing.");
  if (cursor && (cursor as Cursor).phase === "uploads") return uploadsStep(brief, cursor as Cursor, key);
  return searchStep(brief, key);
}

/** The whole run in one call, for scripts and tests. */
async function discover(brief: Brief): Promise<DiscoveryResult> {
  const candidates: Candidate[] = [];
  let cursor: Record<string, unknown> | null = null;
  let quotaUsed = 0;
  let skipped = 0;
  let status: DiscoveryResult["status"] = "completed";
  const notes: string[] = [];
  let report: DiscoveryResult["report"];
  let budget = brief.quotaBudget;
  for (;;) {
    const step = await discoverStep({ ...brief, quotaBudget: budget }, cursor);
    candidates.push(...step.candidates);
    quotaUsed += step.quotaUsed;
    skipped += step.skipped;
    if (step.status !== "completed") status = step.status;
    if (step.note) notes.push(step.note);
    report = step.report ?? report;
    if (budget !== undefined) budget = Math.max(0, budget - step.quotaUsed);
    cursor = step.cursor;
    if (step.done) break;
  }
  return { candidates, status, quotaUsed, skipped, note: notes.join(" ") || null, report };
}

export const youtubeSource: CreatorSource = {
  name: "youtube",
  discover,
  discoverStep,

  async fetchCandidates(brief) {
    const result = await discover(brief);
    if (result.status === "not_configured" || result.status === "failed") throw new Error(result.note ?? "YouTube discovery failed.");
    return result.candidates;
  },

  // Looking a single channel up by handle is not needed yet; discovery fills the profile.
  async enrichProfile(platform, handle) {
    return bareProfile("youtube", platform, handle);
  },
};
