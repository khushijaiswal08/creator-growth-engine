"use server";

import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity";
import { refreshNextAction } from "@/lib/automation";
import { allowed } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { CREATOR_STATUS_LABELS, parseCreatorStatus } from "@/lib/status";

export type ActionResult = { ok: true } | { ok: false; error: string };

/** Changes a creator's status in a campaign and records the change in the Activity log. */
export async function updateCreatorStatus(
  campaignCreatorId: string,
  rawStatus: string,
): Promise<ActionResult> {
  const user = await requireUser();

  const status = parseCreatorStatus(rawStatus);
  if (!status) return { ok: false, error: "Unknown status." };

  // Limited to this person's brand: another brand's creator is simply not found.
  const current = await db.campaignCreator.findFirst({
    where: { id: campaignCreatorId, ...allowed(user).creators },
    select: { status: true, repliedAt: true, influencerId: true, campaignId: true },
  });
  if (!current) return { ok: false, error: "This creator is no longer in the campaign." };
  if (current.status === status) return { ok: true };

  await db.$transaction(async (tx) => {
    await tx.campaignCreator.update({
      where: { id: campaignCreatorId },
      data: {
        status,
        repliedAt: status === "replied" && !current.repliedAt ? new Date() : undefined,
      },
    });
    await logActivity(tx, {
      userId: user.id,
      kind: "status_change",
      campaignCreatorId,
      influencerId: current.influencerId,
      body: `Status changed from ${CREATOR_STATUS_LABELS[current.status]} to ${CREATOR_STATUS_LABELS[status]}.`,
    });
  });

  await refreshNextAction(campaignCreatorId);

  revalidatePath(`/campaigns/${current.campaignId}`);
  revalidatePath(`/influencers/${current.influencerId}`);
  revalidatePath("/today");
  return { ok: true };
}
