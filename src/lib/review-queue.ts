import type { DataSource, EmailStatus, Platform, Prisma, UsSignal } from "@prisma/client";
import { db } from "@/lib/db";
import { PLATFORMS } from "@/lib/profile-url";
import { emailStatusFor, LOW_FIT_SCORE } from "@/lib/scoring";
import { normaliseForMatch, similarHandles } from "@/lib/similar";

export const US_SIGNAL_LABELS: Record<UsSignal, string> = {
  confirmed: "US confirmed",
  likely: "US likely",
  unknown: "US unknown",
  unlikely: "US unlikely",
};
export const US_SIGNALS = Object.keys(US_SIGNAL_LABELS) as UsSignal[];

const SOURCES: DataSource[] = ["youtube", "meta_free", "vendor", "csv", "manual"];
const MAX_QUEUE = 1000;

export type ReviewFilters = {
  platform: Platform | null;
  minScore: number | null;
  email: EmailStatus | null;
  us: UsSignal | null;
  source: DataSource | null;
};

type RawParams = Record<string, string | string[] | undefined>;
const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

export function parseReviewFilters(params: RawParams): ReviewFilters {
  const platform = one(params.platform) as Platform;
  const email = one(params.email) as EmailStatus;
  const us = one(params.us) as UsSignal;
  const source = one(params.source) as DataSource;
  const minScore = Number.parseInt(one(params.minScore), 10);
  return {
    platform: PLATFORMS.includes(platform) ? platform : null,
    minScore: Number.isInteger(minScore) && minScore > 0 && minScore <= 100 ? minScore : null,
    email: email === "found" || email === "not_found" ? email : null,
    us: US_SIGNALS.includes(us) ? us : null,
    source: SOURCES.includes(source) ? source : null,
  };
}

export function reviewFilterQuery(filters: ReviewFilters): string {
  const query = new URLSearchParams();
  if (filters.platform) query.set("platform", filters.platform);
  if (filters.minScore) query.set("minScore", String(filters.minScore));
  if (filters.email) query.set("email", filters.email);
  if (filters.us) query.set("us", filters.us);
  if (filters.source) query.set("source", filters.source);
  return query.toString();
}

export type ReviewItem = {
  campaignCreatorId: string;
  influencerId: string;
  name: string;
  email: string | null;
  location: string | null;
  status: "discovered" | "scored";
  priorityReview: boolean;
  score: number | null;
  lowFit: boolean;
  usSignal: UsSignal | null;
  emailStatus: EmailStatus;
  reasons: string[];
  model: string | null;
  profiles: {
    id: string;
    platform: Platform;
    handle: string;
    followers: number | null;
    bio: string | null;
    source: DataSource;
    fetchNote: string | null;
  }[];
  latestPostUrl: string | null;
  latestPostAt: Date | null;
};

/**
 * Creators waiting for a human decision: status discovered or scored,
 * priority reviews first, then highest score. Email status is always worked
 * out from stored data here, never taken from the model.
 */
export async function loadReviewQueue(campaignId: string, filters: ReviewFilters): Promise<ReviewItem[]> {
  const profileFilter: Prisma.SocialProfileWhereInput = {
    ...(filters.platform ? { platform: filters.platform } : {}),
    ...(filters.source ? { source: filters.source } : {}),
  };

  const creators = await db.campaignCreator.findMany({
    where: {
      campaignId,
      status: { in: ["discovered", "scored"] },
      ...(filters.minScore ? { fitScore: { gte: filters.minScore } } : {}),
      ...(filters.platform || filters.source ? { influencer: { profiles: { some: profileFilter } } } : {}),
    },
    orderBy: [{ priorityReview: "desc" }, { fitScore: { sort: "desc", nulls: "last" } }, { createdAt: "asc" }],
    take: MAX_QUEUE,
    include: {
      influencer: { include: { profiles: { orderBy: { platform: "asc" } } } },
      assessments: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });

  const items: ReviewItem[] = [];
  for (const creator of creators) {
    const assessment = creator.assessments[0] ?? null;
    const emailStatus = emailStatusFor(creator);
    if (filters.email && emailStatus !== filters.email) continue;
    if (filters.us && assessment?.usSignal !== filters.us) continue;

    const newest = [...creator.influencer.profiles]
      .filter((profile) => profile.lastPostUrl)
      .sort((a, b) => (b.lastPostAt?.getTime() ?? 0) - (a.lastPostAt?.getTime() ?? 0))[0];

    items.push({
      campaignCreatorId: creator.id,
      influencerId: creator.influencerId,
      name: creator.influencer.name,
      email: creator.influencer.email,
      location: creator.influencer.location,
      status: creator.status as "discovered" | "scored",
      priorityReview: creator.priorityReview,
      score: assessment?.score ?? null,
      lowFit: assessment !== null && assessment.score < LOW_FIT_SCORE,
      usSignal: assessment?.usSignal ?? null,
      emailStatus,
      reasons: assessment ? assessment.reasons.split("\n").filter(Boolean) : [],
      model: assessment?.model ?? null,
      profiles: creator.influencer.profiles.map((profile) => ({
        id: profile.id,
        platform: profile.platform,
        handle: profile.handle,
        followers: profile.followers,
        bio: profile.bio,
        source: profile.source,
        fetchNote: profile.fetchNote,
      })),
      latestPostUrl: newest?.lastPostUrl ?? null,
      latestPostAt: newest?.lastPostAt ?? null,
    });
  }
  return items;
}

export type DuplicateWarning = { influencerId: string; name: string; platform: Platform; handle: string };

/**
 * For each item, other people whose handle on a different platform looks like
 * the same name. A warning only: the reviewer decides whether it is the same person.
 * `among` limits the search to the creators the reviewer may see, so a
 * warning never names someone from a brand that is not theirs.
 */
export async function findPossibleDuplicates(
  items: ReviewItem[],
  among: Prisma.InfluencerWhereInput = {},
): Promise<Map<string, DuplicateWarning[]>> {
  const warnings = new Map<string, DuplicateWarning[]>();
  if (items.length === 0) return warnings;

  const everyone = await db.socialProfile.findMany({
    where: { influencer: among },
    select: { platform: true, handle: true, influencerId: true, influencer: { select: { name: true } } },
  });
  // Legacy YouTube paths ("channel/UC...") are ids, not names.
  const comparable = everyone
    .filter((profile) => !profile.handle.includes("/"))
    .map((profile) => ({ ...profile, key: normaliseForMatch(profile.handle) }));

  for (const item of items) {
    const found = new Map<string, DuplicateWarning>();
    for (const own of item.profiles) {
      if (own.handle.includes("/")) continue;
      const key = normaliseForMatch(own.handle);
      for (const other of comparable) {
        if (other.influencerId === item.influencerId || other.platform === own.platform) continue;
        if (!similarHandles(key, other.key)) continue;
        found.set(`${other.platform}:${other.handle}`, {
          influencerId: other.influencerId,
          name: other.influencer.name,
          platform: other.platform,
          handle: other.handle,
        });
      }
    }
    if (found.size > 0) warnings.set(item.campaignCreatorId, [...found.values()].slice(0, 3));
  }
  return warnings;
}
