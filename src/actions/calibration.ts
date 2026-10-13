"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/session";

export type VerdictResult = { ok: true } | { ok: false; error: string };

/**
 * Admin: records their own yes or no beside the model's score for one
 * assessment, to measure how often the two agree and tune the prompt.
 * Nothing about the creator changes: the status, score and reasons stay.
 */
export async function recordCalibrationVerdict(assessmentId: string, verdict: boolean, note: string): Promise<VerdictResult> {
  const admin = await requireAdmin();
  const clean = note.trim().slice(0, 500);
  const assessment = await db.fitAssessment.findUnique({ where: { id: assessmentId }, select: { id: true, campaignCreator: { select: { campaign: { select: { brandId: true } } } } } });
  if (!assessment) return { ok: false, error: "That assessment no longer exists." };

  await db.fitAssessment.update({
    where: { id: assessmentId },
    data: { reviewerVerdict: verdict, reviewerNote: clean || null, reviewedById: admin.id, reviewedAt: new Date() },
  });
  revalidatePath("/admin/calibration");
  return { ok: true };
}
