import { createId } from "@paralleldrive/cuid2";
import { Prisma, type DataSource, type RunStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { getCreatorSource, NotImplementedError, type Candidate, type DiscoveryStep } from "@/lib/fetching";
import { lookupInstagramAccount, type MetaReport, type PendingPost } from "@/lib/fetching/adapters/meta-free";
import { displayHandle, normalizeHandle, PLATFORM_LABELS } from "@/lib/profile-url";
import { loadSuppressions } from "@/lib/suppression";
import { youtubeBudget } from "@/lib/youtube-quota";

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

/** How long one slice may hold a run before another worker may take over. */
const LOCK_MS = 90 * 1000;

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
  report: Record<string, unknown> | null;
  /** False while more slices are needed. */
  done: boolean;
};

const candidateKey = (candidate: Pick<Candidate, "platform" | "handle">) => `${candidate.platform}:${candidate.handle}`;

type RunRow = Prisma.DiscoveryRunGetPayload<{ include: { campaign: { select: { id: true; name: true; brief: true; nicheKeywords: true; negativeKeywords: true } } } }>;

function summarise(run: RunRow, done: boolean): DiscoverySummary {
  return {
    runId: run.id,
    source: run.source,
    status: run.status,
    found: run.found,
    added: run.added,
    alreadyKnown: run.alreadyKnown,
    skipped: run.skipped,
    quotaUsed: run.quotaUsed,
    note: run.note,
    report: (run.report as Record<string, unknown> | null) ?? null,
    done,
  };
}

/**
 * Drops candidates already in the system or on the do-not-contact list and
 * adds the rest to the campaign as `discovered`, in one transaction. Every
 * route into the portal (a discovery slice, a reviewer naming a post's author)
 * goes through here, so nobody skips the checks.
 */
export async function admitCandidates(
  run: { id: string; source: DataSource; campaignId: string; campaignName: string },
  candidates: Candidate[],
  userId: string,
): Promise<{ added: number; alreadyKnown: number; skipped: number; outcomes: Map<string, "added" | "known" | "blocked"> }> {
  // The same account can come back from several keywords or posts.
  const unique = [...new Map(candidates.map((candidate) => [candidateKey(candidate), candidate])).values()];
  const outcomes = new Map<string, "added" | "known" | "blocked">();
  if (unique.length === 0) return { added: 0, alreadyKnown: 0, skipped: 0, outcomes };

  const [known, suppressions] = await Promise.all([
    db.socialProfile.findMany({ where: { handle: { in: unique.map((candidate) => candidate.handle) } }, select: { platform: true, handle: true } }),
    loadSuppressions(unique.map((candidate) => ({ email: candidate.email, profiles: [candidate] }))),
  ]);
  const knownKeys = new Set(known.map(candidateKey));

  const influencers: Prisma.InfluencerCreateManyInput[] = [];
  const profiles: Prisma.SocialProfileCreateManyInput[] = [];
  const links: Prisma.CampaignCreatorCreateManyInput[] = [];
  const activities: Prisma.ActivityCreateManyInput[] = [];
  const sourceLabel = SOURCE_LABELS[run.source];
  let alreadyKnown = 0;
  let skipped = 0;

  for (const candidate of unique) {
    if (knownKeys.has(candidateKey(candidate))) {
      alreadyKnown += 1;
      outcomes.set(candidateKey(candidate), "known");
      continue;
    }
    if (suppressions.reasonFor({ email: candidate.email, profiles: [candidate] })) {
      skipped += 1;
      outcomes.set(candidateKey(candidate), "blocked");
      continue;
    }
    const influencerId = createId();
    const linkId = createId();
    const label = `${PLATFORM_LABELS[candidate.platform]} ${displayHandle(candidate.handle)}`;
    influencers.push({ id: influencerId, name: candidate.name ?? candidate.handle, email: candidate.email, location: candidate.location ?? candidate.country });
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
      source: run.source,
    });
    links.push({ id: linkId, campaignId: run.campaignId, influencerId, status: "discovered", discoveryRunId: run.id });
    activities.push(
      { userId, influencerId, kind: "influencer_created", body: `Found by discovery (${sourceLabel}): ${label}.` },
      { userId, influencerId, campaignCreatorId: linkId, kind: "added_to_campaign", body: `Added to campaign "${run.campaignName}" as Discovered by discovery (${sourceLabel}).` },
    );
    outcomes.set(candidateKey(candidate), "added");
  }

  if (influencers.length > 0) {
    await db.$transaction([
      db.influencer.createMany({ data: influencers }),
      db.socialProfile.createMany({ data: profiles }),
      db.campaignCreator.createMany({ data: links }),
      db.activity.createMany({ data: activities }),
    ]);
  }
  return { added: influencers.length, alreadyKnown, skipped, outcomes };
}

/** Starts a run and does its first slice. The screen or the job tick does the rest. */
export async function startDiscovery(args: { campaignId: string; source: DiscoverySource; userId: string }): Promise<DiscoverySummary> {
  const campaign = await db.campaign.findUniqueOrThrow({ where: { id: args.campaignId }, select: { id: true, nicheKeywords: true, negativeKeywords: true } });
  const run = await db.discoveryRun.create({
    data: {
      campaignId: campaign.id,
      startedById: args.userId,
      source: args.source,
      query: { nicheKeywords: campaign.nicheKeywords, negativeKeywords: campaign.negativeKeywords },
      cursor: { phase: "start" },
    },
  });
  return discoverySlice(run.id);
}

/**
 * One slice of a running discovery: asks the adapter for the next step,
 * admits what it found, records what the live service answered, and finishes
 * the run when there is nothing left. Safe to call from two places: a lock
 * on the run keeps the screen and the scheduled tick from working the same
 * slice at once.
 */
export async function discoverySlice(runId: string, now = new Date()): Promise<DiscoverySummary> {
  const claimed = await db.discoveryRun.updateMany({
    where: { id: runId, status: "running", OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { lockedUntil: new Date(now.getTime() + LOCK_MS) },
  });
  const run = await db.discoveryRun.findUniqueOrThrow({
    where: { id: runId },
    include: { campaign: { select: { id: true, name: true, brief: true, nicheKeywords: true, negativeKeywords: true } } },
  });
  // Finished already, or another worker holds it: report as it stands.
  if (claimed.count === 0) return summarise(run, run.status !== "running");

  const cursor = run.cursor as Record<string, unknown> | null;
  const started = cursor !== null && (cursor as { phase?: string }).phase !== "start";
  let step: DiscoveryStep;
  try {
    const adapter = getCreatorSource(run.source);
    const brief = {
      campaignId: run.campaign.id,
      text: run.campaign.brief,
      nicheKeywords: run.campaign.nicheKeywords,
      negativeKeywords: run.campaign.negativeKeywords,
      // YouTube: what is left of today's 80% allowance, counting this run's earlier slices too.
      ...(run.source === "youtube" ? { quotaBudget: (await youtubeBudget(now)).remaining } : {}),
    };
    if (adapter.discoverStep) step = await adapter.discoverStep(brief, started ? cursor : null);
    else if (adapter.discover) step = { ...(await adapter.discover(brief)), cursor: null, done: true };
    else step = { candidates: await adapter.fetchCandidates(brief), status: "completed", quotaUsed: 0, skipped: 0, note: null, cursor: null, done: true };
  } catch (error) {
    step = {
      candidates: [],
      status: error instanceof NotImplementedError ? "not_configured" : "failed",
      quotaUsed: 0,
      skipped: 0,
      note: error instanceof Error ? error.message : "Discovery failed.",
      cursor: null,
      done: true,
    };
  }

  let admitted = { added: 0, alreadyKnown: 0, skipped: 0 };
  let note = step.note;
  let status = step.status;
  try {
    admitted = await admitCandidates({ id: run.id, source: run.source, campaignId: run.campaign.id, campaignName: run.campaign.name }, step.candidates, run.startedById);
  } catch (error) {
    console.error("Saving discovery results failed", error);
    status = "failed";
    note = [note, "The results of this step could not be saved. Run it again."].filter(Boolean).join(" ");
    step.done = true;
  }

  // A quota stop or failure in an earlier slice outranks a clean last slice.
  const earlier = (cursor as { _runStatus?: RunStatus } | null)?._runStatus;
  const worst: RunStatus = status !== "completed" ? status : (earlier ?? "completed");
  const finalStatus: RunStatus = step.done ? worst : "running";
  const updated = await db.discoveryRun.update({
    where: { id: run.id },
    data: {
      found: { increment: step.candidates.length },
      added: { increment: admitted.added },
      alreadyKnown: { increment: admitted.alreadyKnown },
      skipped: { increment: step.skipped + admitted.skipped },
      quotaUsed: { increment: step.quotaUsed },
      note: [run.note, note].filter(Boolean).join(" ") || null,
      report: (step.report as Prisma.InputJsonValue | undefined) ?? (run.report as Prisma.InputJsonValue | null) ?? undefined,
      cursor: step.done ? Prisma.DbNull : ({ ...(step.cursor ?? {}), _runStatus: worst } as Prisma.InputJsonObject),
      lockedUntil: null,
      ...(step.done ? { status: finalStatus, finishedAt: now } : {}),
    },
    include: { campaign: { select: { id: true, name: true, brief: true, nicheKeywords: true, negativeKeywords: true } } },
  });

  if (step.done) {
    await db.activity.create({
      data: {
        userId: run.startedById,
        kind: "discovery_run",
        body: `Discovery (${SOURCE_LABELS[run.source]}) for "${run.campaign.name}": ${updated.found} found, ${updated.added} new, ${updated.alreadyKnown} already known, ${updated.skipped} skipped, ${updated.quotaUsed} ${run.source === "youtube" ? "quota units" : "API calls"}. ${RUN_STATUS_LABELS[updated.status]}.`,
      },
    });
  }
  return summarise(updated, step.done);
}

/** The whole run in one call, for scripts and tests. The screen uses start + slices. */
export async function runDiscovery(args: { campaignId: string; source: DiscoverySource; userId: string }): Promise<DiscoverySummary> {
  let summary = await startDiscovery(args);
  while (!summary.done) summary = await discoverySlice(summary.runId);
  return summary;
}

/** Posts from this campaign's Instagram runs whose author a reviewer still has to name. */
export async function pendingPosts(campaignId: string): Promise<{ runId: string; post: PendingPost }[]> {
  const runs = await db.discoveryRun.findMany({
    where: { campaignId, source: "meta_free", report: { not: Prisma.DbNull } },
    orderBy: { startedAt: "desc" },
    take: 10,
    select: { id: true, report: true },
  });
  return runs.flatMap((run) => (((run.report as MetaReport | null)?.pending ?? []) as PendingPost[]).map((post) => ({ runId: run.id, post })));
}

export type AttributeOutcome = { ok: true; outcome: "added" | "known" | "blocked"; statsFound: boolean | null } | { ok: false; error: string };

/**
 * A reviewer names the account behind a post Meta would not attribute. The
 * account is looked up for stats and then admitted exactly like a discovered
 * one: dedupe and the do-not-contact list still apply.
 */
export async function attributePost(args: { runId: string; permalink: string; handle: string; userId: string; userName: string }): Promise<AttributeOutcome> {
  const handle = normalizeHandle("instagram", args.handle);
  if (!handle) return { ok: false, error: "That does not look like an Instagram handle." };

  const run = await db.discoveryRun.findUniqueOrThrow({ where: { id: args.runId }, include: { campaign: { select: { id: true, name: true } } } });
  const report = (run.report as MetaReport | null) ?? null;
  const post = report?.pending.find((item) => item.permalink === args.permalink);
  if (!report || !post) return { ok: false, error: "That post is no longer waiting for a handle." };

  const { candidate, statsFound } = await lookupInstagramAccount(handle, post);
  const admitted = await admitCandidates({ id: run.id, source: "meta_free", campaignId: run.campaign.id, campaignName: run.campaign.name }, [candidate], args.userId);
  const outcome = admitted.outcomes.get(candidateKey(candidate)) ?? "known";

  const nextReport: MetaReport = {
    ...report,
    pending: report.pending.filter((item) => item.permalink !== args.permalink),
    attributed: [...(report.attributed ?? []), { permalink: args.permalink, handle, outcome, by: args.userName, at: new Date().toISOString() }],
  };
  await db.$transaction([
    db.discoveryRun.update({
      where: { id: run.id },
      data: { report: nextReport as unknown as Prisma.InputJsonObject, found: { increment: 1 }, added: { increment: outcome === "added" ? 1 : 0 }, alreadyKnown: { increment: outcome === "known" ? 1 : 0 }, skipped: { increment: outcome === "blocked" ? 1 : 0 } },
    }),
    db.activity.create({
      data: {
        userId: args.userId,
        kind: "discovery_run",
        body: `Named @${handle} as the author of a post from Instagram discovery for "${run.campaign.name}": ${outcome === "added" ? "added as Discovered" : outcome === "known" ? "already in the portal" : "on the do-not-contact list, not added"}.`,
      },
    }),
  ]);
  return { ok: true, outcome, statsFound };
}

/** A reviewer drops a post that is not worth naming. */
export async function dismissPost(args: { runId: string; permalink: string }): Promise<boolean> {
  const run = await db.discoveryRun.findUniqueOrThrow({ where: { id: args.runId }, select: { report: true } });
  const report = (run.report as MetaReport | null) ?? null;
  if (!report?.pending.some((item) => item.permalink === args.permalink)) return false;
  await db.discoveryRun.update({
    where: { id: args.runId },
    data: { report: { ...report, pending: report.pending.filter((item) => item.permalink !== args.permalink) } as unknown as Prisma.InputJsonObject },
  });
  return true;
}
