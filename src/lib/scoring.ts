import Anthropic from "@anthropic-ai/sdk";
import { Prisma, type EmailStatus, type UsSignal } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { emailInText, mapLimit } from "@/lib/fetching/adapters/shared";
import { estimateCostUsd } from "@/lib/model-prices";
import { PLATFORM_LABELS } from "@/lib/profile-url";
import { activePromptFor, type ActivePrompt } from "@/lib/scoring-prompts";
import { CREATOR_STATUS_LABELS } from "@/lib/status";

/** The built-in prompt's version label. Brand versions are "brand:vN" (see scoring-prompts.ts). */
export const PROMPT_VERSION = "fit-v1";

export const PRIORITY_SCORE = 75;
export const LOW_FIT_SCORE = 40;

const DEFAULT_MODEL = "claude-opus-5-5";
const CONCURRENCY = 3;
/** Creators scored per slice: one round of CONCURRENCY requests, so a slice stays inside a short request limit. */
export const BATCH_SIZE = 3;
/** How long one slice may hold a run before another worker may take over. */
const LOCK_MS = 90 * 1000;

// Models that accept the server-side refusal fallback.
const FALLBACK_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"]);

export function scoringModel(): string {
  return process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
}

export function scoringConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim());
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", description: "Weighted fit score from 0 to 100." },
    usSignal: { type: "string", enum: ["confirmed", "likely", "unknown", "unlikely"] },
    reasons: { type: "array", items: { type: "string" } },
  },
  required: ["score", "usSignal", "reasons"],
  additionalProperties: false,
} as const;

const outputSchema = z.object({
  score: z.number().int().min(0).max(100),
  usSignal: z.enum(["confirmed", "likely", "unknown", "unlikely"]),
  reasons: z.array(z.string().min(1)).min(1).max(8),
});

type CreatorForScoring = Prisma.CampaignCreatorGetPayload<{ include: { influencer: { include: { profiles: true } } } }>;
type CampaignForScoring = { name: string; brief: string; nicheKeywords: string[]; negativeKeywords: string[] };

const EMAIL_ANYWHERE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** Email addresses are never sent to the model; only whether one exists. */
const redact = (text: string) => text.replace(EMAIL_ANYWHERE, "[email]");

/** Found means an address is stored or literally written in a bio. Never inferred. */
export function emailStatusFor(creator: CreatorForScoring): EmailStatus {
  if (creator.influencer.email) return "found";
  return creator.influencer.profiles.some((profile) => emailInText(profile.bio)) ? "found" : "not_found";
}

function campaignBlock(campaign: CampaignForScoring): string {
  return [
    "<campaign>",
    `Brief: ${campaign.brief}`,
    `Niche keywords: ${campaign.nicheKeywords.join(", ") || "none given"}`,
    `Negative keywords: ${campaign.negativeKeywords.join(", ") || "none given"}`,
    "</campaign>",
  ].join("\n");
}

function creatorBlock(creator: CreatorForScoring, emailStatus: EmailStatus): string {
  const lines = ["<creator_profile>", `Location on file: ${creator.influencer.location ?? "not known"}`, `Email status: ${emailStatus === "found" ? "found" : "not found"}`];
  for (const profile of creator.influencer.profiles) {
    lines.push(
      "",
      `Platform: ${PLATFORM_LABELS[profile.platform]}`,
      `Followers: ${profile.followers ?? "not known"}`,
      `Engagement rate: ${profile.engagementRate !== null ? `${profile.engagementRate}%` : "not known"}`,
      `Country reported by platform: ${profile.country ?? "not reported"}`,
      `Last post: ${profile.lastPostAt ? profile.lastPostAt.toISOString().slice(0, 10) : "not known"}`,
      `Website: ${profile.website ?? "none"}`,
      `Bio: ${profile.bio ? redact(profile.bio) : "none"}`,
    );
    if (profile.recentCaptions.length > 0) lines.push("Recent captions:", ...profile.recentCaptions.slice(0, 5).map((caption) => `- ${redact(caption)}`));
    else lines.push("Recent captions: not available");
    if (profile.fetchNote) lines.push(`Note: ${profile.fetchNote}`);
  }
  lines.push("</creator_profile>", "", "Assess this creator's fit for the campaign.");
  return lines.join("\n");
}

type Usage = { requests: number; inputTokens: number; outputTokens: number };

type Scored =
  | { ok: true; score: number; usSignal: UsSignal; reasons: string[]; model: string }
  | { ok: false; error: string; fatal?: "auth" | "rate_limit" };

/** One creator, one request (two if the first answer fails validation). */
async function assess(client: Anthropic, prompt: ActivePrompt, campaign: CampaignForScoring, creator: CreatorForScoring, emailStatus: EmailStatus, usage: Usage): Promise<Scored> {
  const model = scoringModel();
  const useFallbacks = FALLBACK_MODELS.has(model);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      usage.requests += 1;
      const response = await client.beta.messages.create({
        model,
        max_tokens: 4000,
        // A declined request is re-run on Anthropic's recommended fallback model.
        ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        system: [
          { type: "text", text: prompt.systemPrompt },
          // Same for every creator in the campaign, so it can be served from cache.
          { type: "text", text: campaignBlock(campaign), cache_control: { type: "ephemeral" } },
        ],
        output_config: {
          ...(model.startsWith("claude-haiku") ? {} : { effort: "low" as const }),
          format: { type: "json_schema", schema: OUTPUT_SCHEMA },
        },
        messages: [{ role: "user", content: creatorBlock(creator, emailStatus) }],
      });

      usage.inputTokens += response.usage.input_tokens + (response.usage.cache_read_input_tokens ?? 0) + (response.usage.cache_creation_input_tokens ?? 0);
      usage.outputTokens += response.usage.output_tokens;

      if (response.stop_reason === "refusal") return { ok: false, error: "The model declined to assess this profile." };
      if (response.stop_reason === "max_tokens") return { ok: false, error: "The model's answer was cut off." };

      const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      const parsed = outputSchema.safeParse(JSON.parse(text));
      if (parsed.success) return { ok: true, ...parsed.data, model: response.model };
      // Out-of-range score or empty reasons: ask once more, then give up on this creator.
    } catch (error) {
      // The SDK has already retried rate limits and server errors with backoff.
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return { ok: false, error: "Anthropic rejected the API key.", fatal: "auth" };
      if (error instanceof Anthropic.RateLimitError) return { ok: false, error: "Anthropic's rate limit was reached.", fatal: "rate_limit" };
      if (error instanceof Anthropic.BadRequestError) return { ok: false, error: `Request rejected: ${error.message}` };
      if (error instanceof Anthropic.APIError) return { ok: false, error: `Anthropic API error ${error.status ?? ""}`.trim() };
      if (!(error instanceof SyntaxError)) throw error;
      // SyntaxError: the answer was not valid JSON. Try once more.
    }
  }
  return { ok: false, error: "The model's answer did not match the required format." };
}

export type ScoringProgress = {
  runId: string;
  status: "running" | "completed" | "stopped_quota" | "not_configured" | "failed";
  scoredThisBatch: number;
  failedIds: string[];
  remaining: number;
  totals: { scored: number; failed: number; requests: number; inputTokens: number; outputTokens: number; estimatedCostUsd: number | null };
  promptVersion: string;
  model: string;
  note: string | null;
};

type Cursor = { failedIds: string[] };

/** Creates the run row for a campaign, recording the model and the brand's active prompt version. */
export async function startScoring(args: { campaignId: string; userId: string; excludeIds?: string[] }): Promise<string> {
  const campaign = await db.campaign.findUniqueOrThrow({ where: { id: args.campaignId }, select: { brandId: true } });
  const prompt = await activePromptFor(campaign.brandId);
  const run = await db.scoringRun.create({
    data: {
      campaignId: args.campaignId,
      startedById: args.userId,
      model: scoringModel(),
      promptVersion: prompt.label,
      scoringPromptId: prompt.id,
      cursor: { failedIds: args.excludeIds ?? [] } satisfies Cursor,
    },
  });
  return run.id;
}

/**
 * One slice of a scoring run: up to BATCH_SIZE discovered creators with no
 * assessment yet, CONCURRENCY at a time. The screen calls it while someone
 * watches; the job tick calls it otherwise. A lock keeps the two apart.
 *
 * It only ever moves a creator from discovered to scored. It never approves.
 */
export async function scoringSlice(runId: string, now = new Date()): Promise<ScoringProgress> {
  const claimed = await db.scoringRun.updateMany({
    where: { id: runId, status: "running", OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { lockedUntil: new Date(now.getTime() + LOCK_MS) },
  });
  const run = await db.scoringRun.findUniqueOrThrow({ where: { id: runId }, include: { campaign: { select: { brandId: true, name: true, brief: true, nicheKeywords: true, negativeKeywords: true } } } });
  const cursor = ((run.cursor as Cursor | null) ?? { failedIds: [] }) as Cursor;

  const progress = (status: ScoringProgress["status"], extra: Partial<ScoringProgress> = {}): ScoringProgress => ({
    runId: run.id,
    status,
    scoredThisBatch: 0,
    failedIds: [],
    remaining: 0,
    totals: { scored: run.scored, failed: run.failed, requests: run.requests, inputTokens: run.inputTokens, outputTokens: run.outputTokens, estimatedCostUsd: run.estimatedCostUsd === null ? null : Number(run.estimatedCostUsd) },
    promptVersion: run.promptVersion,
    model: run.model,
    note: run.note,
    ...extra,
  });
  if (claimed.count === 0) return progress(run.status === "running" ? "running" : (run.status as ScoringProgress["status"]));

  const finish = async (status: ScoringProgress["status"], note: string | null, extra: Partial<ScoringProgress> = {}) => {
    const updated = await db.scoringRun.update({
      where: { id: run.id },
      data: status === "running" ? { lockedUntil: null } : { status, finishedAt: new Date(), note, lockedUntil: null, cursor: Prisma.DbNull },
    });
    if (status !== "running") {
      await db.activity.create({
        data: {
          userId: run.startedById,
          kind: "scoring_run",
          body: `AI fit scoring (${updated.model}, prompt ${updated.promptVersion}): ${updated.scored} scored, ${updated.failed} failed, ${updated.requests} requests, ${updated.inputTokens} input and ${updated.outputTokens} output tokens, about $${Number(updated.estimatedCostUsd ?? 0).toFixed(2)}.${note ? ` ${note}` : ""}`,
        },
      });
    }
    return {
      ...progress(status, extra),
      totals: { scored: updated.scored, failed: updated.failed, requests: updated.requests, inputTokens: updated.inputTokens, outputTokens: updated.outputTokens, estimatedCostUsd: updated.estimatedCostUsd === null ? null : Number(updated.estimatedCostUsd) },
      note,
    } satisfies ScoringProgress;
  };

  if (!scoringConfigured()) return finish("not_configured", "AI scoring is not configured: ANTHROPIC_API_KEY is missing.");

  const where: Prisma.CampaignCreatorWhereInput = { campaignId: run.campaignId, status: "discovered", assessments: { none: {} }, id: { notIn: cursor.failedIds } };
  const [prompt, batch] = await Promise.all([
    activePromptFor(run.campaign.brandId),
    db.campaignCreator.findMany({ where, orderBy: { createdAt: "asc" }, take: BATCH_SIZE, include: { influencer: { include: { profiles: true } } } }),
  ]);
  if (batch.length === 0) return finish("completed", cursor.failedIds.length > 0 ? `${cursor.failedIds.length} could not be scored and stay Discovered.` : null);

  const client = new Anthropic({ maxRetries: 4 });
  const usage: Usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
  const failedIds: string[] = [];
  let scored = 0;
  let fatal: { status: "failed" | "stopped_quota"; note: string } | null = null;

  await mapLimit(
    batch,
    CONCURRENCY,
    async (creator) => {
      const emailStatus = emailStatusFor(creator);
      const result = await assess(client, prompt, run.campaign, creator, emailStatus, usage);
      if (!result.ok) {
        if (result.fatal === "auth") fatal = { status: "failed", note: "Anthropic rejected the API key. Check ANTHROPIC_API_KEY." };
        else if (result.fatal === "rate_limit") fatal = { status: "stopped_quota", note: "Anthropic's rate limit was reached. Run scoring again later to continue." };
        else failedIds.push(creator.id);
        return;
      }
      const priority = result.score >= PRIORITY_SCORE;
      const tag = priority ? ", priority review" : result.score < LOW_FIT_SCORE ? ", low fit" : "";
      // Guarded on status so a creator a person has already moved is left alone.
      const saved = await db.$transaction(async (tx) => {
        const moved = await tx.campaignCreator.updateMany({ where: { id: creator.id, status: "discovered" }, data: { status: "scored", fitScore: result.score, fitReason: result.reasons[0], priorityReview: priority } });
        if (moved.count === 0) return false;
        await tx.fitAssessment.create({
          data: { campaignCreatorId: creator.id, scoringRunId: run.id, score: result.score, usSignal: result.usSignal, emailStatus, reasons: result.reasons.join("\n"), model: result.model, promptVersion: prompt.label, scoringPromptId: prompt.id },
        });
        await tx.activity.create({
          data: {
            userId: run.startedById,
            campaignCreatorId: creator.id,
            influencerId: creator.influencerId,
            kind: "status_change",
            body: `Status changed from ${CREATOR_STATUS_LABELS.discovered} to ${CREATOR_STATUS_LABELS.scored} by AI fit scoring (score ${result.score}${tag}). A recommendation only.`,
          },
        });
        return true;
      });
      if (saved) scored += 1;
    },
    () => fatal !== null,
  );

  const allFailed = [...cursor.failedIds, ...failedIds];
  const inputTokens = run.inputTokens + usage.inputTokens;
  const outputTokens = run.outputTokens + usage.outputTokens;
  await db.scoringRun.update({
    where: { id: run.id },
    data: {
      scored: { increment: scored },
      failed: { increment: failedIds.length },
      requests: { increment: usage.requests },
      inputTokens: { increment: usage.inputTokens },
      outputTokens: { increment: usage.outputTokens },
      estimatedCostUsd: estimateCostUsd(run.model, inputTokens, outputTokens),
      cursor: { failedIds: allFailed } satisfies Cursor,
    },
  });

  const stop = fatal as { status: "failed" | "stopped_quota"; note: string } | null;
  if (stop) return finish(stop.status, stop.note, { scoredThisBatch: scored, failedIds });

  const remaining = await db.campaignCreator.count({ where: { ...where, id: { notIn: allFailed } } });
  if (remaining === 0) return finish("completed", allFailed.length > 0 ? `${allFailed.length} could not be scored and stay Discovered.` : null, { scoredThisBatch: scored, failedIds });
  return finish("running", null, { scoredThisBatch: scored, failedIds, remaining });
}

/**
 * One batch, for the screen: starts a run when there is none, otherwise
 * continues the one given. `excludeIds` are creators that failed earlier.
 */
export async function scoreBatch(args: { campaignId: string; userId: string; runId?: string | null; excludeIds?: string[] }): Promise<ScoringProgress> {
  const runId = args.runId ?? (await startScoring({ campaignId: args.campaignId, userId: args.userId, excludeIds: args.excludeIds }));
  return scoringSlice(runId);
}

/**
 * Scores every discovered creator in the campaign that has no assessment.
 * For scripts and tests; the screen and the job tick go slice by slice.
 */
export async function scoreCampaign(campaignId: string, userId: string): Promise<ScoringProgress> {
  const runId = await startScoring({ campaignId, userId });
  let progress = await scoringSlice(runId);
  while (progress.status === "running") progress = await scoringSlice(runId);
  return progress;
}
