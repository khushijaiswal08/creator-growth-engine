"use server";

import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity";
import { refreshNextAction } from "@/lib/automation";
import { allowed } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import { field, type FormState } from "@/lib/form";
import { isReplyClass, REPLY_CLASS_LABELS, REPLY_OUTCOMES } from "@/lib/replies";
import { requireUser } from "@/lib/session";
import { CREATOR_STATUS_LABELS } from "@/lib/status";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Records a creator's reply and moves them on according to what they said.
 * A person chooses the class; the status, collaboration type and next action
 * follow from it.
 */
export async function logReply(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();

  const campaignCreatorId = field(formData, "campaignCreatorId");
  const replyClass = field(formData, "replyClass");
  const text = field(formData, "text");
  if (!isReplyClass(replyClass)) return { error: "Choose what the creator said." };
  if (text.length > 5000) return { error: "The reply text is too long." };

  let requestedFee: number | null = null;
  if (replyClass === "rate_requested" && field(formData, "requestedFee")) {
    requestedFee = Number(field(formData, "requestedFee"));
    if (!Number.isInteger(requestedFee) || requestedFee < 0 || requestedFee > 1_000_000) {
      return { error: "Enter the fee as a whole number of dollars." };
    }
  }

  let reengageAfter: Date | null = null;
  if (replyClass === "maybe_later") {
    const raw = field(formData, "reengageAfter");
    reengageAfter = raw ? new Date(`${raw}T00:00:00Z`) : new Date(Date.now() + 60 * DAY);
    if (Number.isNaN(reengageAfter.getTime())) return { error: "That date is not valid." };
  }

  const current = await db.campaignCreator.findFirst({
    where: { id: campaignCreatorId, ...allowed(user).creators },
    select: { status: true, influencerId: true, campaignId: true, repliedAt: true, collaborationType: true },
  });
  if (!current) return { error: "This creator is no longer in the campaign." };

  const outcome = REPLY_OUTCOMES[replyClass];
  const now = new Date();

  await db.$transaction(async (tx) => {
    await tx.message.create({
      data: {
        campaignCreatorId,
        userId: user.id,
        channel: "dm",
        direction: "inbound",
        body: text || `(${REPLY_CLASS_LABELS[replyClass]})`,
        sentAt: now,
        classification: replyClass,
        // Sorted by a person, so there is no doubt about it.
        classificationConfidence: 1,
      },
    });
    await tx.campaignCreator.update({
      where: { id: campaignCreatorId },
      data: {
        status: outcome.status,
        repliedAt: current.repliedAt ?? now,
        collaborationType: outcome.collaborationType ?? current.collaborationType ?? undefined,
        requestedFee: requestedFee ?? undefined,
        reengageAfter: replyClass === "maybe_later" ? reengageAfter : undefined,
      },
    });
    await logActivity(tx, {
      userId: user.id,
      kind: "message_logged",
      campaignCreatorId,
      influencerId: current.influencerId,
      body: `Reply logged: ${REPLY_CLASS_LABELS[replyClass]}${requestedFee !== null ? ` ($${requestedFee})` : ""}.`,
    });
    if (current.status !== outcome.status) {
      await logActivity(tx, {
        userId: user.id,
        kind: "status_change",
        campaignCreatorId,
        influencerId: current.influencerId,
        body: `Status changed from ${CREATOR_STATUS_LABELS[current.status]} to ${CREATOR_STATUS_LABELS[outcome.status]}.`,
      });
    }
  });
  await refreshNextAction(campaignCreatorId, now);

  revalidatePath(`/campaigns/${current.campaignId}`);
  revalidatePath(`/influencers/${current.influencerId}`);
  revalidatePath("/today");
  return { message: `Logged. ${outcome.explains}` };
}
