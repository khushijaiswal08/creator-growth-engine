import { normalizeHandle } from "@/lib/profile-url";
import type { Candidate, CreatorSource, DiscoveryResult } from "../types";
import { bareProfile, clip, emailInText, mapLimit, matchesNegative } from "./shared";

/**
 * YouTube Data API v3. The key is read from the server environment only.
 *
 * Quota: the default allowance is 10,000 units a day. search.list costs 100,
 * channels.list and playlistItems.list cost 1 each, so searches are what to
 * ration. A run searches at most MAX_SEARCHES keywords.
 */
// YOUTUBE_API_BASE_URL exists so tests can point the adapter at a recorded-response server.
const API = process.env.YOUTUBE_API_BASE_URL?.trim() || "https://www.googleapis.com/youtube/v3";
const MAX_SEARCHES = 5;
const RESULTS_PER_SEARCH = 25;
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
  items?: {
    snippet?: { title?: string; publishedAt?: string };
    contentDetails?: { videoId?: string; videoPublishedAt?: string };
  }[];
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

async function discover(brief: Parameters<NonNullable<CreatorSource["discover"]>>[0]): Promise<DiscoveryResult> {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key) {
    return {
      candidates: [],
      status: "not_configured",
      quotaUsed: 0,
      skipped: 0,
      note: "YouTube is not configured: YOUTUBE_API_KEY is missing.",
    };
  }

  const keywords = (brief.nicheKeywords ?? []).filter(Boolean).slice(0, MAX_SEARCHES);
  const negatives = (brief.negativeKeywords ?? []).filter(Boolean);
  if (keywords.length === 0) {
    return {
      candidates: [],
      status: "failed",
      quotaUsed: 0,
      skipped: 0,
      note: "The campaign has no niche keywords to search for.",
    };
  }

  const candidates: Candidate[] = [];
  let quotaUsed = 0;
  let skipped = 0;
  let status: DiscoveryResult["status"] = "completed";
  let note: string | null = null;

  try {
    // 1. One channel search per keyword. Negative keywords are excluded in the query itself.
    const channelIds = new Set<string>();
    for (const keyword of keywords) {
      const q = [keyword, ...negatives.map((negative) => `-"${negative}"`)].join(" ");
      quotaUsed += COST.search;
      const found = await call<SearchResponse>(
        "search",
        {
          part: "snippet",
          type: "channel",
          q,
          maxResults: String(RESULTS_PER_SEARCH),
          regionCode: "US",
          relevanceLanguage: "en",
        },
        key,
      );
      for (const item of found.items ?? []) {
        if (item.id?.channelId) channelIds.add(item.id.channelId);
      }
    }

    // 2. Channel details, 50 ids per call.
    const ids = [...channelIds].slice(0, brief.limit ?? 200);
    const channels: NonNullable<ChannelsResponse["items"]> = [];
    for (let start = 0; start < ids.length; start += 50) {
      quotaUsed += COST.channels;
      const page = await call<ChannelsResponse>(
        "channels",
        { part: "snippet,statistics,contentDetails", id: ids.slice(start, start + 50).join(","), maxResults: "50" },
        key,
      );
      channels.push(...(page.items ?? []));
    }

    // 3. Latest uploads per channel, for the last upload date and recent titles.
    let quotaHit = false;
    await mapLimit(
      channels,
      4,
      async (channel) => {
        const title = channel.snippet?.title ?? "";
        const description = channel.snippet?.description ?? "";
        if (matchesNegative(`${title} ${description}`, negatives)) {
          skipped += 1;
          return;
        }

        const handle =
          (channel.snippet?.customUrl ? normalizeHandle("youtube", channel.snippet.customUrl) : null) ??
          `channel/${channel.id}`;

        const candidate: Candidate = {
          ...bareProfile("youtube", "youtube", handle),
          name: title || null,
          bio: description ? clip(description, 1000) : null,
          email: emailInText(description),
          followers:
            channel.statistics?.hiddenSubscriberCount || channel.statistics?.subscriberCount === undefined
              ? null
              : Number(channel.statistics.subscriberCount),
          country: channel.snippet?.country ?? null,
          fetchNote: channel.statistics?.hiddenSubscriberCount ? "Subscriber count is hidden by the channel." : null,
          fetchedAt: new Date(),
        };

        const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
        if (uploads && !quotaHit) {
          try {
            quotaUsed += COST.playlistItems;
            const latest = await call<PlaylistItemsResponse>(
              "playlistItems",
              { part: "snippet,contentDetails", playlistId: uploads, maxResults: "5" },
              key,
            );
            const items = latest.items ?? [];
            const newest = items[0];
            const published = newest?.contentDetails?.videoPublishedAt ?? newest?.snippet?.publishedAt;
            candidate.lastPostAt = published ? new Date(published) : null;
            candidate.lastPostUrl = newest?.contentDetails?.videoId
              ? `https://www.youtube.com/watch?v=${newest.contentDetails.videoId}`
              : null;
            candidate.recentCaptions = items.flatMap((item) => (item.snippet?.title ? [clip(item.snippet.title, 200)] : []));
          } catch (error) {
            // Keep the channel; only its recent uploads are unknown.
            if (error instanceof QuotaExhausted) quotaHit = true;
            else candidate.fetchNote = "Recent uploads could not be read.";
          }
        }

        candidates.push(candidate);
      },
    );

    if (quotaHit) {
      status = "stopped_quota";
      note = `The YouTube daily quota ran out while reading recent uploads. ${candidates.length} channels were kept, some without their latest upload.`;
    }
  } catch (error) {
    if (error instanceof QuotaExhausted) {
      status = "stopped_quota";
      note = `The YouTube daily quota is exhausted; it resets at midnight Pacific Time. ${candidates.length} channels were read before it ran out.`;
    } else {
      status = "failed";
      note = error instanceof Error ? error.message : "YouTube discovery failed.";
    }
  }

  return { candidates, status, quotaUsed, skipped, note };
}

export const youtubeSource: CreatorSource = {
  name: "youtube",

  discover,

  async fetchCandidates(brief) {
    const result = await discover(brief);
    if (result.status === "not_configured" || result.status === "failed") {
      throw new Error(result.note ?? "YouTube discovery failed.");
    }
    return result.candidates;
  },

  // Looking a single channel up by handle is not needed yet; discovery fills the profile.
  async enrichProfile(platform, handle) {
    return bareProfile("youtube", platform, handle);
  },
};
