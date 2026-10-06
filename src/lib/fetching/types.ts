import type { DataSource, Platform } from "@prisma/client";

/**
 * What a campaign is looking for. `input` carries the raw payload for the
 * adapters that have no remote API: CSV text for "csv", one profile URL per
 * line for "manual".
 */
export type Brief = {
  campaignId?: string;
  text?: string;
  nicheKeywords?: string[];
  negativeKeywords?: string[];
  platforms?: Platform[];
  limit?: number;
  input?: string;
};

export type ProfileData = {
  platform: Platform;
  handle: string;
  name: string | null;
  email: string | null;
  location: string | null;
  followers: number | null;
  engagementRate: number | null;
  bio: string | null;
  website: string | null;
  /** Country as reported by the platform, when it reports one. */
  country: string | null;
  lastPostAt: Date | null;
  lastPostUrl: string | null;
  /** Recent captions or video titles, newest first. */
  recentCaptions: string[];
  /** Why stats are missing, e.g. "Not a professional account". */
  fetchNote: string | null;
  /** When the data was fetched from the platform; null when nothing was fetched. */
  fetchedAt: Date | null;
  source: DataSource;
};

export type Candidate = ProfileData;

/** How a discovery ended. Mirrors the RunStatus values a DiscoveryRun can finish with. */
export type DiscoveryStatus = "completed" | "stopped_quota" | "not_configured" | "failed";

export type DiscoveryResult = {
  candidates: Candidate[];
  status: DiscoveryStatus;
  /** YouTube quota units, or number of Meta API calls. */
  quotaUsed: number;
  /** Results the adapter dropped itself, e.g. for matching a negative keyword. */
  skipped: number;
  /** Plain-language account of anything that cut the run short. */
  note: string | null;
};

/** The one interface every creator data source implements. */
export interface CreatorSource {
  readonly name: DataSource;
  fetchCandidates(brief: Brief): Promise<Candidate[]>;
  enrichProfile(platform: Platform, handle: string): Promise<ProfileData>;
  /**
   * Optional richer form of fetchCandidates for sources with quotas: it never
   * throws for an exhausted quota or missing key, it reports them.
   */
  discover?(brief: Brief): Promise<DiscoveryResult>;
}
