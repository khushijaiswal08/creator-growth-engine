"use server";

import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity";
import { refreshNextAction } from "@/lib/automation";
import { allowed, type BrandScope } from "@/lib/brand-scope";
import { brandName } from "@/lib/brands";
import { db } from "@/lib/db";
import { displayHandle, PLATFORM_LABELS } from "@/lib/profile-url";
import { ensureSelectionUrl } from "@/lib/selection";
import { requireUser } from "@/lib/session";
import { CREATOR_STATUS_LABELS, PRE_CONTACT_STATUSES, SEND_BLOCKED_STATUSES } from "@/lib/status";
import { loadSuppressions } from "@/lib/suppression";

type LogMessageInput = {
  campaignCreatorId: string;
  socialProfileId: string;
  templateId: string | null;
  body: string;
};

export type LogMessageResult =
  | { ok: true; movedToContacted: boolean }
  | { ok: false; error: string };

/**
 * Loads the creator and applies every rule that can forbid contact, the suppression list included.
 * A creator of a brand outside the scope is not found at all.
 */
async function loadSendable(campaignCreatorId: string, scope: BrandScope) {
  const creator = await db.campaignCreator.findFirst({
    where: { id: campaignCreatorId, ...scope.creators },
    include: { influencer: { include: { profiles: true } }, campaign: { select: { brandId: true } } },
  });
  if (!creator) return { ok: false as const, error: "This creator is no longer in the campaign." };

  if (creator.influencer.archived) return { ok: false as const, error: "This influencer is archived." };
  if (SEND_BLOCKED_STATUSES.has(creator.status)) {
    return {
      ok: false as const,
      error: `Creators marked ${CREATOR_STATUS_LABELS[creator.status]} cannot be messaged.`,
    };
  }

  const suppressions = await loadSuppressions([creator.influencer]);
  const suppressed = suppressions.reasonFor(creator.influencer);
  if (suppressed) return { ok: false as const, error: `On the suppression list: ${suppressed}` };

  return { ok: true as const, creator };
}

/**
 * Called when the message dialog opens. The copy-and-open button stays
 * disabled until this passes, so the suppression list is checked before the
 * user can send anything, not only when the message is logged. Also returns
 * what the templates need: the brand and the creator's product-selection link.
 */
export async function checkMessageAllowed(
  campaignCreatorId: string,
): Promise<{ ok: true; brand: string; selectionUrl: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const sendable = await loadSendable(campaignCreatorId, allowed(user));
  if (!sendable.ok) return sendable;
  return {
    ok: true,
    brand: brandName(sendable.creator.campaign.brandId),
    selectionUrl: await ensureSelectionUrl(campaignCreatorId),
  };
}

/**
 * Records a DM the user is about to send by hand. Nothing is sent from here:
 * the browser copies the text and opens the platform; this writes the Message
 * and Activity rows and moves the creator on:
 *
 *   not yet contacted -> Contacted
 *   Follow-up due     -> Contacted, with one more follow-up counted
 *   message contains the creator's selection link -> link marked as sent
 */
export async function logOutboundMessage(input: LogMessageInput): Promise<LogMessageResult> {
  const user = await requireUser();

  const body = input.body.trim();
  if (!body) return { ok: false, error: "The message is empty." };
  if (body.length > 5000) return { ok: false, error: "The message is too long." };

  const sendable = await loadSendable(input.campaignCreatorId, allowed(user));
  if (!sendable.ok) return sendable;
  const { creator } = sendable;

  const profile = creator.influencer.profiles.find((p) => p.id === input.socialProfileId);
  if (!profile) return { ok: false, error: "That profile does not belong to this creator." };

  const template = input.templateId
    ? await db.template.findUnique({ where: { id: input.templateId }, select: { id: true, name: true } })
    : null;

  const firstContact = PRE_CONTACT_STATUSES.has(creator.status);
  const isFollowUp = creator.status === "follow_up_due";
  const movedToContacted = firstContact || isFollowUp;
  const sharesSelectionLink = Boolean(creator.selectionToken && body.includes(`/select/${creator.selectionToken}`));
  const now = new Date();
  const target = `${PLATFORM_LABELS[profile.platform]} ${displayHandle(profile.handle)}`;

  await db.$transaction(async (tx) => {
    await tx.message.create({
      data: {
        campaignCreatorId: creator.id,
        userId: user.id,
        channel: "dm",
        direction: "outbound",
        body,
        templateId: template?.id ?? null,
        sentAt: now,
      },
    });
    await tx.campaignCreator.update({
      where: { id: creator.id },
      data: {
        lastContactedAt: now,
        status: movedToContacted ? "contacted" : undefined,
        followUpsSent: isFollowUp ? { increment: 1 } : undefined,
        selectionSentAt: sharesSelectionLink && !creator.selectionSentAt ? now : undefined,
      },
    });
    await logActivity(tx, {
      userId: user.id,
      kind: "message_logged",
      campaignCreatorId: creator.id,
      influencerId: creator.influencerId,
      body: `Message copied and ${target} opened${template ? ` (template "${template.name}")` : ""}${isFollowUp ? `, follow-up ${creator.followUpsSent + 1}` : ""}${sharesSelectionLink ? ", with the product selection link" : ""}.`,
    });
    if (movedToContacted) {
      await logActivity(tx, {
        userId: user.id,
        kind: "status_change",
        campaignCreatorId: creator.id,
        influencerId: creator.influencerId,
        body: `Status changed from ${CREATOR_STATUS_LABELS[creator.status]} to ${CREATOR_STATUS_LABELS.contacted}.`,
      });
    }
  });
  await refreshNextAction(creator.id, now);

  revalidatePath(`/campaigns/${creator.campaignId}`);
  revalidatePath(`/influencers/${creator.influencerId}`);
  revalidatePath("/today");
  return { ok: true, movedToContacted };
}
