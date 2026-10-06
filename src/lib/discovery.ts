import { createId } from "@paralleldrive/cuid2";
import type { DataSource, Prisma, RunStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { getCreatorSource, NotImplementedError, type Candidate, type DiscoveryResult } from "@/lib/fetching";
import { displayHandle, PLATFORM_LABELS } from "@/lib/profile-url";
import { loadSuppressions } from "@/lib/suppression";

export const DISCOVERY_SOURCES = ["youtube", "meta_free"] as const satisfies readonly DataSource[];
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

export const SOURCE_LABELS: Record<DataSource, string> = {
  youtube: "YouTube",
  meta_free: "Instagram hashtags (Meta)",
  vendor: "Data vendor",
  csv: "CSV import",
  manual: "Added by hand",
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  running: "Running",
  completed: "Completed",
  stopped_quota: "Stopped: quota reached",
  not_configured: "Not configured",
  failed: "Failed",
};

export type DiscoverySummary = {
  runId: string;
  source: DataSource;
  status: RunStatus;
  found: number;
  added: number;
  alreadyKnown: number;
  skipped: number;
  quotaUsed: number;
  note: string | null;
};

const candidateKey = (candidate: Pick<Candidate, "platform" | "handle">) => `${candidate.platform}:${candidate.handle}`;

/**
 * Runs one discovery for a campaign: asks the adapter for candidates, drops
 * anyone already in the system or on the do-not-contact list, and adds the
 * rest to the campaign as `discovered`. Always leaves a finished DiscoveryRun
 * behind, whatever happens.
 */
export async function runDiscovery(args: {
  campaignId: string;
  source: DiscoverySource;
  userId: string;
}): Promise<DiscoverySummary> {
  const campaign = await db.campaign.findUniqueOrThrow({
    where: { id: args.campaignId },
    select: { id: true, name: true, brief: true, nicheKeywords: true, negativeKeywords: true },
  });

  const run = await db.discoveryRun.create({
    data: {
      campaignId: campaign.id,
      startedById: args.userId,
      source: args.source,
      query: { nicheKeywords: campaign.nicheKeywords, negativeKeywords: campaign.negativeKeywords },
    },
  });

  let result: DiscoveryResult;
  try {
    const adapter = getCreatorSource(args.source);
    const brief = {
      campaignId: campaign.id,
      text: campaign.brief,
      nicheKeywords: campaign.nicheKeywords,
      negativeKeywords: campaign.negativeKeywords,
    };
    result = adapter.discover
      ? await adapter.discover(brief)
      : { candidates: await adapter.fetchCandidates(brief), status: "completed", quotaUsed: 0, skipped: 0, note: null };
  } catch (error) {
    result = {
      candidates: [],
      status: error instanceof NotImplementedError ? "not_configured" : "failed",
      quotaUsed: 0,
      skipped: 0,
      note: error instanceof Error ? error.message : "Discovery failed.",
    };
  }

  // The same account can come back from several keywords.
  const unique = [...new Map(result.candidates.map((candidate) => [candidateKey(candidate), candidate])).values()];

  const summary: DiscoverySummary = {
    runId: run.id,
    source: args.source,
    status: result.status,
    found: unique.length,
    added: 0,
    alreadyKnown: 0,
    skipped: result.skipped,
    quotaUsed: result.quotaUsed,
    note: result.note,
  };

  try {
    const [known, suppressions] = await Promise.all([
      db.socialProfile.findMany({
        where: { handle: { in: unique.map((candidate) => candidate.handle) } },
        select: { platform: true, handle: true },
      }),
      loadSuppressions(unique.map((candidate) => ({ email: candidate.email, profiles: [candidate] }))),
    ]);
    const knownKeys = new Set(known.map(candidateKey));

    const influencers: Prisma.InfluencerCreateManyInput[] = [];
    const profiles: Prisma.SocialProfileCreateManyInput[] = [];
    const links: Prisma.CampaignCreatorCreateManyInput[] = [];
    const activities: Prisma.ActivityCreateManyInput[] = [];
    const sourceLabel = SOURCE_LABELS[args.source];

    for (const candidate of unique) {
      if (knownKeys.has(candidateKey(candidate))) {
        summary.alreadyKnown += 1;
        continue;
      }
      if (suppressions.reasonFor({ email: candidate.email, profiles: [candidate] })) {
        summary.skipped += 1;
        continue;
      }

      const influencerId = createId();
      const linkId = createId();
      const label = `${PLATFORM_LABELS[candidate.platform]} ${displayHandle(candidate.handle)}`;

      influencers.push({
        id: influencerId,
        name: candidate.name ?? candidate.handle,
        email: candidate.email,
        location: candidate.location ?? candidate.country,
      });
      profiles.push({
        id: createId(),
        influencerId,
        platform: candidate.platform,
        handle: candidate.handle,
        followers: candidate.followers,
        engagementRate: candidate.engagementRate,
        bio: candidate.bio,
        website: candidate.website,
        country: candidate.country,
        lastPostAt: candidate.lastPostAt,
        lastPostUrl: candidate.lastPostUrl,
        recentCaptions: candidate.recentCaptions,
        fetchNote: candidate.fetchNote,
        lastFetchedAt: candidate.fetchedAt,
        source: args.source,
      });
      links.push({ id: linkId, campaignId: campaign.id, influencerId, status: "discovered", discoveryRunId: run.id });
      activities.push(
        { userId: args.userId, influencerId, kind: "influencer_created", body: `Found by discovery (${sourceLabel}): ${label}.` },
        {
          userId: args.userId,
          influencerId,
          campaignCreatorId: linkId,
          kind: "added_to_campaign",
          body: `Added to campaign "${campaign.name}" as Discovered by discovery (${sourceLabel}).`,
        },
      );
    }
    summary.added = influencers.length;

    activities.push({
      userId: args.userId,
      kind: "discovery_run",
      body: `Discovery (${sourceLabel}) for "${campaign.name}": ${summary.found} found, ${summary.added} new, ${summary.alreadyKnown} already known, ${summary.skipped} skipped. ${RUN_STATUS_LABELS[summary.status]}.`,
    });

    const writes: Prisma.PrismaPromise<unknown>[] = [];
    if (influencers.length > 0) {
      writes.push(
        db.influencer.createMany({ data: influencers }),
        db.socialProfile.createMany({ data: profiles }),
        db.campaignCreator.createMany({ data: links }),
      );
    }
    writes.push(
      db.activity.createMany({ data: activities }),
      db.discoveryRun.update({
        where: { id: run.id },
        data: {
          status: summary.status,
          finishedAt: new Date(),
          found: summary.found,
          added: summary.added,
          alreadyKnown: summary.alreadyKnown,
          skipped: summary.skipped,
          quotaUsed: summary.quotaUsed,
          note: summary.note,
        },
      }),
    );
    await db.$transaction(writes);
  } catch (error) {
    console.error("Saving discovery results failed", error);
    summary.status = "failed";
    summary.added = 0;
    summary.note = [summary.note, "The results could not be saved, so nobody was added. Run it again."].filter(Boolean).join(" ");
    await db.discoveryRun.update({
      where: { id: run.id },
      data: { status: "failed", finishedAt: new Date(), found: summary.found, quotaUsed: summary.quotaUsed, note: summary.note },
    });
  }

  return summary;
}
