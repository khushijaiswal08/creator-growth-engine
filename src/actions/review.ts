"use server";

import type { CreatorStatus } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity";
import { refreshNextAction } from "@/lib/automation";
import { allowed } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import { displayHandle, PLATFORM_LABELS } from "@/lib/profile-url";
import { requireUser } from "@/lib/session";
import { CREATOR_STATUS_LABELS } from "@/lib/status";

export type ReviewResult = { ok: true } | { ok: false; error: string };

const DECISIONS = { approve: "approved", reject: "rejected", later: "review_later" } as const satisfies Record<
  string,
  CreatorStatus
>;
export type ReviewDecision = keyof typeof DECISIONS;

const REVIEWABLE: CreatorStatus[] = ["discovered", "scored"];

/** A person's decision on a queued creator. Only people decide; the scoring job never calls this. */
export async function decideReview(campaignCreatorId: string, decision: ReviewDecision): Promise<ReviewResult> {
  const user = await requireUser();
  const status = DECISIONS[decision];
  if (!status) return { ok: false, error: "Unknown decision." };

  const current = await db.campaignCreator.findFirst({
    where: { id: campaignCreatorId, ...allowed(user).creators },
    select: { status: true, influencerId: true, campaignId: true, fitScore: true },
  });
  if (!current) return { ok: false, error: "This creator is no longer in the campaign." };
  if (!REVIEWABLE.includes(current.status)) {
    return { ok: false, error: `Already ${CREATOR_STATUS_LABELS[current.status]}; someone else got there first.` };
  }

  await db.$transaction(async (tx) => {
    await tx.campaignCreator.update({ where: { id: campaignCreatorId }, data: { status, priorityReview: false } });
    await logActivity(tx, {
      userId: user.id,
      kind: "status_change",
      campaignCreatorId,
      influencerId: current.influencerId,
      body: `Status changed from ${CREATOR_STATUS_LABELS[current.status]} to ${CREATOR_STATUS_LABELS[status]} in the review queue${current.fitScore !== null ? ` (AI score was ${current.fitScore})` : ""}.`,
    });
  });

  await refreshNextAction(campaignCreatorId);

  revalidatePath(`/campaigns/${current.campaignId}`);
  revalidatePath(`/campaigns/${current.campaignId}/review`);
  revalidatePath(`/influencers/${current.influencerId}`);
  revalidatePath("/today");
  return { ok: true };
}

/** Blacklists the creator and puts every handle and email of theirs on the do-not-contact list. */
export async function blacklistFromReview(campaignCreatorId: string, rawReason: string): Promise<ReviewResult> {
  const user = await requireUser();
  const reason = rawReason.trim();
  if (reason.length < 3) return { ok: false, error: "Give a reason for the blacklist." };
  if (reason.length > 300) return { ok: false, error: "Keep the reason under 300 characters." };

  const current = await db.campaignCreator.findFirst({
    where: { id: campaignCreatorId, ...allowed(user).creators },
    include: { influencer: { include: { profiles: true } } },
  });
  if (!current) return { ok: false, error: "This creator is no longer in the campaign." };
  if (current.status === "blacklisted") return { ok: true };

  const { influencer } = current;
  const email = influencer.email?.toLowerCase() ?? null;
  const blocked = [
    ...influencer.profiles.map((profile) => `${PLATFORM_LABELS[profile.platform]} ${displayHandle(profile.handle)}`),
    ...(email ? [email] : []),
  ];

  await db.$transaction(async (tx) => {
    await tx.campaignCreator.update({
      where: { id: campaignCreatorId },
      data: { status: "blacklisted", priorityReview: false },
    });
    // skipDuplicates: a handle or email already on the list keeps its original reason.
    await tx.suppression.createMany({
      data: [
        ...influencer.profiles.map((profile) => ({ platform: profile.platform, handle: profile.handle, reason })),
        ...(email ? [{ email, reason }] : []),
      ],
      skipDuplicates: true,
    });
    await logActivity(tx, {
      userId: user.id,
      kind: "status_change",
      campaignCreatorId,
      influencerId: influencer.id,
      body: `Status changed from ${CREATOR_STATUS_LABELS[current.status]} to ${CREATOR_STATUS_LABELS.blacklisted}. Reason: ${reason}`,
    });
    await logActivity(tx, {
      userId: user.id,
      kind: "suppression_added",
      influencerId: influencer.id,
      body: `Added to the do-not-contact list: ${blocked.join(", ")}. Reason: ${reason}`,
    });
  });

  await refreshNextAction(campaignCreatorId);

  revalidatePath(`/campaigns/${current.campaignId}`);
  revalidatePath(`/campaigns/${current.campaignId}/review`);
  revalidatePath(`/influencers/${influencer.id}`);
  revalidatePath("/admin/suppression");
  revalidatePath("/today");
  return { ok: true };
}
