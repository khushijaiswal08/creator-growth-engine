import type { DataSource, EmailStatus, Platform, Prisma, UsSignal } from "@prisma/client";
import { db } from "@/lib/db";
import { emailInText } from "@/lib/fetching/adapters/shared";
import { PLATFORMS } from "@/lib/profile-url";
import { LOW_FIT_SCORE } from "@/lib/scoring";
import { normaliseForMatch, similarHandles } from "@/lib/similar";
import { REVIEW_STATUSES, US_SIGNALS } from "@/lib/status";

const SOURCES: DataSource[] = ["youtube", "meta_free", "meta_marketplace", "vendor", "csv", "manual"];
const MAX_QUEUE = 1000;

type ReviewFilters = {
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

type ReviewItem = {
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

/** The filters the database can apply. Email and US signal are worked out after reading. */
function queueWhere(campaignId: string, filters: ReviewFilters): Prisma.CampaignCreatorWhereInput {
  const profileFilter: Prisma.SocialProfileWhereInput = {
    ...(filters.platform ? { platform: filters.platform } : {}),
    ...(filters.source ? { source: filters.source } : {}),
  };
  return {
    campaignId,
    status: { in: REVIEW_STATUSES },
    ...(filters.minScore ? { fitScore: { gte: filters.minScore } } : {}),
    ...(filters.platform || filters.source ? { influencer: { profiles: { some: profileFilter } } } : {}),
  };
}

/**
 * The same rule as emailStatusFor in scoring.ts (stored address, or one written in a bio),
 * for the narrow rows read here: that helper's type wants every profile column.
 */
function queueEmailStatus(influencer: { email: string | null; profiles: { bio: string | null }[] }): EmailStatus {
  if (influencer.email) return "found";
  return influencer.profiles.some((profile) => emailInText(profile.bio)) ? "found" : "not_found";
}

/**
 * Creators waiting for a human decision: status discovered or scored,
 * priority reviews first, then highest score. Email status is always worked
 * out from stored data here, never taken from the model.
 */
export function loadReviewQueue(campaignId: string, filters: ReviewFilters): Promise<ReviewItem[]> {
  return readQueue(campaignId, filters, MAX_QUEUE);
}

/**
 * The first `limit` items of the queue and how many are waiting in all (up to the
 * queue's own cap), for the review page. Without an email or US filter the database
 * can count and cut the list, so the page does not read up to 1000 rows to show 30.
 */
export async function loadReviewQueuePage(campaignId: string, filters: ReviewFilters, limit: number): Promise<{ items: ReviewItem[]; waiting: number }> {
  if (filters.email || filters.us) {
    const items = await loadReviewQueue(campaignId, filters);
    return { items: items.slice(0, limit), waiting: items.length };
  }
  const [items, count] = await Promise.all([readQueue(campaignId, filters, limit), db.campaignCreator.count({ where: queueWhere(campaignId, filters) })]);
  return { items, waiting: Math.min(count, MAX_QUEUE) };
}

async function readQueue(campaignId: string, filters: ReviewFilters, take: number): Promise<ReviewItem[]> {
  // Only the columns a review card or the CSV export reads: the full rows carry notes, captions and GMV detail.
  const creators = await db.campaignCreator.findMany({
    where: queueWhere(campaignId, filters),
    orderBy: [{ priorityReview: "desc" }, { fitScore: { sort: "desc", nulls: "last" } }, { createdAt: "asc" }],
    take,
    select: {
      id: true,
      influencerId: true,
      status: true,
      priorityReview: true,
      influencer: {
        select: {
          name: true,
          email: true,
          location: true,
          profiles: {
            orderBy: { platform: "asc" },
            select: { id: true, platform: true, handle: true, followers: true, bio: true, source: true, fetchNote: true, lastPostUrl: true, lastPostAt: true },
          },
        },
      },
      assessments: { orderBy: { createdAt: "desc" }, take: 1, select: { score: true, usSignal: true, reasons: true } },
    },
  });

  const items: ReviewItem[] = [];
  for (const creator of creators) {
    const assessment = creator.assessments[0] ?? null;
    const emailStatus = queueEmailStatus(creator.influencer);
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

type DuplicateWarning = { influencerId: string; name: string; platform: Platform; handle: string };

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

  // Legacy YouTube paths ("channel/UC...") are ids, not names, so they are left out in the query.
  const everyone = await db.socialProfile.findMany({
    where: { influencer: among, NOT: { handle: { contains: "/" } } },
    select: { platform: true, handle: true, influencerId: true, influencer: { select: { name: true } } },
  });
  const comparable = everyone.map((profile) => ({ ...profile, key: normaliseForMatch(profile.handle) }));

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
