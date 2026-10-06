"use server";

import { revalidatePath } from "next/cache";
import { allowed } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import { scoreBatch, type ScoringProgress } from "@/lib/scoring";
import { requireUser } from "@/lib/session";

export type ScoringActionResult = { ok: true; progress: ScoringProgress } | { ok: false; error: string };

/**
 * Admin only. Scores one batch of discovered creators. The screen calls this
 * in a loop, passing back the run id and the ids that failed, until the run
 * stops being "running".
 */
export async function scoreCampaignBatch(
  campaignId: string,
  runId: string | null,
  excludeIds: string[],
): Promise<ScoringActionResult> {
  const user = await requireUser();
  if (user.role !== "admin") return { ok: false, error: "Only an admin can run AI scoring." };

  const campaign = await db.campaign.findFirst({ where: { id: campaignId, ...allowed(user).campaigns }, select: { id: true } });
  if (!campaign) return { ok: false, error: "This campaign no longer exists." };

  if (runId) {
    const run = await db.scoringRun.findUnique({ where: { id: runId }, select: { campaignId: true, status: true } });
    if (!run || run.campaignId !== campaignId) return { ok: false, error: "That scoring run does not belong to this campaign." };
    if (run.status !== "running") return { ok: false, error: "That scoring run has already finished." };
  }

  try {
    const progress = await scoreBatch({
      campaignId,
      userId: user.id,
      runId,
      excludeIds: excludeIds.filter((id) => typeof id === "string").slice(0, 5000),
    });
    revalidatePath(`/campaigns/${campaignId}`);
    revalidatePath(`/campaigns/${campaignId}/review`);
    return { ok: true, progress };
  } catch (error) {
    console.error("Scoring batch failed", error);
    return { ok: false, error: "Scoring stopped because of an unexpected error. Creators already scored were saved." };
  }
}
