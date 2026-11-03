"use server";

import type { Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { refreshNextAction } from "@/lib/automation";
import { allowed } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";

type ContentDecision = "approve" | "changes";

/** What both decisions need from the file: its name for the activity line and whose it is. */
const ASSET_SELECT = { id: true, fileName: true, campaignCreatorId: true, campaignCreator: { select: { influencerId: true } } } satisfies Prisma.ContentAssetSelect;

/**
 * Someone on the team approves a creator's file, or asks for changes with a
 * note. Asking for changes sends nothing: the person writes to the creator
 * themselves, as with every other message.
 */
export async function reviewContent(assetId: string, decision: ContentDecision, rawNote = ""): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  const note = String(rawNote ?? "").trim().slice(0, 1000);
  if (decision !== "approve" && decision !== "changes") return { ok: false, error: "Unknown decision." };
  if (decision === "changes" && !note) return { ok: false, error: "Say what should change, so the next message can tell the creator." };

  const asset = await db.contentAsset.findFirst({
    where: { id: assetId, archived: false, status: { not: "uploading" }, campaignCreator: allowed(user).creators },
    select: ASSET_SELECT,
  });
  if (!asset) return { ok: false, error: "That file is not available." };

  await db.$transaction([
    db.contentAsset.update({
      where: { id: asset.id },
      data: { status: decision === "approve" ? "approved" : "changes_requested", reviewNote: decision === "changes" ? note : null, reviewedById: user.id, reviewedAt: new Date() },
    }),
    db.activity.create({
      data: {
        userId: user.id,
        campaignCreatorId: asset.campaignCreatorId,
        influencerId: asset.campaignCreator.influencerId,
        kind: "content_reviewed",
        body: decision === "approve" ? `Approved the file "${asset.fileName}".` : `Asked for changes to "${asset.fileName}": ${note}`,
      },
    }),
  ]);
  await refreshNextAction(asset.campaignCreatorId);
  revalidatePath("/content");
  revalidatePath("/today");
  return { ok: true };
}

/** Takes a file out of the library. The record and the stored file are kept; nothing is deleted. */
export async function archiveContent(assetId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  const asset = await db.contentAsset.findFirst({
    where: { id: assetId, archived: false, campaignCreator: allowed(user).creators },
    select: ASSET_SELECT,
  });
  if (!asset) return { ok: false, error: "That file is not available." };
  await db.$transaction([
    db.contentAsset.update({ where: { id: asset.id }, data: { archived: true } }),
    db.activity.create({
      data: { userId: user.id, campaignCreatorId: asset.campaignCreatorId, influencerId: asset.campaignCreator.influencerId, kind: "content_reviewed", body: `Removed "${asset.fileName}" from the content library (the file is kept).` },
    }),
  ]);
  await refreshNextAction(asset.campaignCreatorId);
  revalidatePath("/content");
  return { ok: true };
}
