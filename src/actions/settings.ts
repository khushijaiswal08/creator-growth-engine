"use server";

import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity";
import { allowed } from "@/lib/brand-scope";
import { brandName, isBrandId } from "@/lib/brands";
import { db } from "@/lib/db";
import { field, type FormState } from "@/lib/form";
import { mcfConfigured } from "@/lib/mcf";
import { activatePromptVersion, createPromptVersion, parseWeights, WEIGHT_KEYS } from "@/lib/scoring-prompts";
import { requireAdmin, requireUser } from "@/lib/session";

const TARGET_MAX = 1000;

/** Daily and weekly message targets for a brand. Anyone on that brand may set them. */
export async function saveBrandTargets(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const brandId = field(formData, "brandId");
  if (!isBrandId(brandId) || !allowed(user).includes(brandId)) return { error: "That brand is not yours to change." };

  const daily = Number(field(formData, "daily"));
  const weekly = Number(field(formData, "weekly"));
  for (const value of [daily, weekly]) {
    if (!Number.isInteger(value) || value < 0 || value > TARGET_MAX) return { error: `Targets must be whole numbers from 0 to ${TARGET_MAX}.` };
  }
  // The brand's Creator Connections page: empty means the Amazon Ads console home.
  const link = field(formData, "creatorConnectionsUrl");
  if (link && (link.length > 500 || !/^https:\/\/[^\s]+$/.test(link))) return { error: "The Creator Connections link must start with https:// and contain no spaces." };
  const creatorConnectionsUrl = link || null;

  await db.$transaction(async (tx) => {
    await tx.brandSettings.upsert({
      where: { brandId },
      update: { dailyMessageTarget: daily, weeklyMessageTarget: weekly, creatorConnectionsUrl, updatedById: user.id },
      create: { brandId, dailyMessageTarget: daily, weeklyMessageTarget: weekly, creatorConnectionsUrl, updatedById: user.id },
    });
    await logActivity(tx, { userId: user.id, kind: "note", body: `Set ${brandName(brandId)} message targets to ${daily} a day and ${weekly} a week${creatorConnectionsUrl ? ", and the Creator Connections link" : ""}.` });
  });
  revalidatePath("/settings");
  revalidatePath("/today");
  return { message: "Targets saved." };
}

/**
 * Admin: automatic Amazon orders for a brand. Off by default; it can only be switched on once the brand's
 * SP-API keys are set. The hold and the 24-hour cap are the two safety limits (see src/lib/mcf-auto.ts).
 */
export async function saveAutoSend(_prev: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  const brandId = field(formData, "brandId");
  if (!isBrandId(brandId)) return { error: "Unknown brand." };
  const on = field(formData, "on") === "on";
  if (on && !mcfConfigured(brandId)) return { error: `${brandName(brandId)} has no Amazon keys yet, so orders cannot go to Amazon on their own.` };
  const hold = Number(field(formData, "holdMinutes"));
  const cap = Number(field(formData, "dailyCap"));
  if (!Number.isInteger(hold) || hold < 0 || hold > 1440) return { error: "The wait after approval must be a whole number of minutes from 0 to 1,440 (a day)." };
  if (!Number.isInteger(cap) || cap < 1 || cap > 100) return { error: "The daily limit must be a whole number from 1 to 100." };

  await db.$transaction(async (tx) => {
    await tx.brandSettings.upsert({
      where: { brandId },
      update: { mcfAutoSend: on, mcfAutoHoldMinutes: hold, mcfAutoDailyCap: cap, updatedById: admin.id },
      create: { brandId, mcfAutoSend: on, mcfAutoHoldMinutes: hold, mcfAutoDailyCap: cap, updatedById: admin.id },
    });
    await logActivity(tx, {
      userId: admin.id,
      kind: "note",
      body: on
        ? `Switched automatic Amazon orders ON for ${brandName(brandId)}: approved gifts go to Amazon ${hold} minutes after approval, at most ${cap} in 24 hours.`
        : `Switched automatic Amazon orders OFF for ${brandName(brandId)}.`,
    });
  });
  revalidatePath("/settings");
  return { message: on ? "Saved. Automatic Amazon orders are on for this brand." : "Saved. Automatic Amazon orders are off for this brand." };
}

/** Admin: a new version of the scoring prompt for a brand, made active at once. */
export async function saveScoringPrompt(_prev: FormState, formData: FormData): Promise<FormState> {
  const admin = await requireAdmin();
  const brandId = field(formData, "brandId");
  if (!isBrandId(brandId)) return { error: "Unknown brand." };

  const guidance = field(formData, "guidance");
  if (guidance.length < 40) return { error: "The guidance is too short to be useful." };
  if (guidance.length > 6000) return { error: "The guidance is too long (6,000 characters at most)." };

  const weights = parseWeights(Object.fromEntries(WEIGHT_KEYS.map((key) => [key, Number(field(formData, key))])));
  if (!weights) return { error: "The six weights must be whole numbers that add up to 100." };

  const { version } = await createPromptVersion({ brandId, guidance, weights, note: field(formData, "note") || null, userId: admin.id });
  revalidatePath("/settings");
  return { message: `Saved as version ${version} and made active. New scoring runs use it; old scores keep their version.` };
}

/** Admin: make an earlier version active again. */
export async function activateScoringPrompt(brandId: string, version: number): Promise<FormState> {
  const admin = await requireAdmin();
  if (!isBrandId(brandId) || !Number.isInteger(version)) return { error: "Unknown version." };
  const ok = await activatePromptVersion({ brandId, version, userId: admin.id });
  revalidatePath("/settings");
  return ok ? { message: `Version ${version} is active.` } : { error: "That version does not exist." };
}
