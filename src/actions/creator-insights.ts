"use server";

import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity";
import { allowed } from "@/lib/brand-scope";
import { parseSuppliedInsight } from "@/lib/creator-insights";
import { db } from "@/lib/db";
import type { FormState } from "@/lib/form";
import { displayHandle, PLATFORM_LABELS } from "@/lib/profile-url";
import { refreshPublicPosts } from "@/lib/public-posts";
import { requireUser } from "@/lib/session";

const refreshScreens = () => revalidatePath("/campaigns/[id]/review", "page");

/** What the form sends: every cell as typed. */
export type InsightInput = Record<"reach7d" | "reach30d" | "profileViews30d" | "usAudiencePct" | "evidence" | "note" | "asOf", string>;

/**
 * A person types in the numbers a creator sent about their own account (a
 * screenshot of their Insights, a media kit). Each entry is kept with who added
 * it and the date the figures are for; the review card shows the newest. The
 * profile must belong to a creator inside the person's own brand.
 */
export async function saveCreatorInsight(profileId: string, input: InsightInput): Promise<FormState> {
  const user = await requireUser();
  const profile = await db.socialProfile.findFirst({
    where: { id: typeof profileId === "string" ? profileId : "", influencer: allowed(user).influencers },
    select: { id: true, platform: true, handle: true, influencerId: true },
  });
  if (!profile) return { error: "That profile is not one you can open." };

  // A forged call can send anything: every cell is read as text and the rules in parseSuppliedInsight decide.
  const cell = (name: keyof InsightInput) => (typeof input?.[name] === "string" ? input[name] : "");
  const parsed = parseSuppliedInsight(
    { reach7d: cell("reach7d"), reach30d: cell("reach30d"), profileViews30d: cell("profileViews30d"), usAudiencePct: cell("usAudiencePct"), evidence: cell("evidence"), note: cell("note"), asOf: cell("asOf") },
    new Date(),
  );
  if (!parsed.ok) return { error: parsed.error };
  const value = parsed.value;

  const parts = [
    value.reach7d !== null && `reached ${value.reach7d.toLocaleString("en-US")} in 7 days`,
    value.reach30d !== null && `reached ${value.reach30d.toLocaleString("en-US")} in 30 days`,
    value.profileViews30d !== null && `${value.profileViews30d.toLocaleString("en-US")} profile views in 30 days`,
    value.usAudiencePct !== null && `${value.usAudiencePct}% US audience`,
  ].filter(Boolean);
  await db.$transaction(async (tx) => {
    await tx.creatorInsight.create({ data: { socialProfileId: profile.id, addedById: user.id, ...value }, select: { id: true } });
    await logActivity(tx, {
      userId: user.id,
      kind: "note",
      influencerId: profile.influencerId,
      body: `Creator-supplied insights for ${PLATFORM_LABELS[profile.platform]} ${displayHandle(profile.handle)} (as of ${value.asOf.toISOString().slice(0, 10)}${value.evidence ? `, from ${value.evidence}` : ""}): ${parts.join(", ")}.`,
    });
  });

  refreshScreens();
  revalidatePath(`/influencers/${profile.influencerId}`);
  return { message: "Saved." };
}

/** Looks the profile up again on its platform and keeps the public posts it shows now. */
export async function refreshPublicNumbers(profileId: string): Promise<FormState> {
  const user = await requireUser();
  const result = await refreshPublicPosts(typeof profileId === "string" ? profileId : "", allowed(user));
  if (!result.ok) return { error: result.error };
  refreshScreens();
  return { message: result.message };
}
