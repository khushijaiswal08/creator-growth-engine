"use server";

import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity";
import { allowed } from "@/lib/brand-scope";
import { loadCreatorCard, type CreatorCard } from "@/lib/creator-card-data";
import { db } from "@/lib/db";
import { field, type FormState } from "@/lib/form";
import { requireUser } from "@/lib/session";

/** The creator card, for a creator the person may see. */
export async function getCreatorCard(influencerId: string): Promise<CreatorCard | null> {
  const user = await requireUser();
  return loadCreatorCard(influencerId, allowed(user));
}

const COUNTS = ["views", "likes", "comments", "shares", "clicks"] as const;

/**
 * Logs a post's numbers as of now: views, likes, comments, shares, clicks and
 * sales. Each save is a new reading, so the history stays; the card shows the
 * latest. Until the Amazon reports are imported these are typed in by hand
 * from the creator's screenshots or Amazon Attribution.
 */
export async function logPostNumbers(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const postId = field(formData, "postId");

  const numbers: Partial<Record<(typeof COUNTS)[number], number>> = {};
  for (const name of COUNTS) {
    const raw = field(formData, name).replace(/,/g, "");
    if (!raw) continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 1_000_000_000) return { error: `${name[0].toUpperCase()}${name.slice(1)}: whole numbers only.` };
    numbers[name] = value;
  }
  const salesRaw = field(formData, "salesUsd").replace(/[$,\s]/g, "");
  let salesUsd: number | null = null;
  if (salesRaw) {
    salesUsd = Number(salesRaw);
    if (!Number.isFinite(salesUsd) || salesUsd < 0 || salesUsd > 10_000_000) return { error: "Sales: a dollar amount, like 96 or 96.50." };
    salesUsd = Math.round(salesUsd * 100) / 100;
  }
  if (Object.keys(numbers).length === 0 && salesUsd === null) return { error: "Enter at least one number." };

  const post = await db.post.findFirst({
    where: { id: postId, campaignCreator: allowed(user).creators },
    select: { id: true, format: true, campaignCreatorId: true, campaignCreator: { select: { influencerId: true, campaignId: true } } },
  });
  if (!post) return { error: "That post is not one you can edit." };

  const parts = [
    ...COUNTS.filter((name) => numbers[name] !== undefined).map((name) => `${numbers[name]!.toLocaleString("en-US")} ${name}`),
    ...(salesUsd !== null ? [`$${salesUsd.toLocaleString("en-US")} in sales`] : []),
  ];
  await db.$transaction(async (tx) => {
    await tx.metric.create({ data: { postId: post.id, ...numbers, salesUsd } });
    await logActivity(tx, {
      userId: user.id,
      kind: "note",
      campaignCreatorId: post.campaignCreatorId,
      influencerId: post.campaignCreator.influencerId,
      body: `Numbers logged for the ${post.format ?? "post"}: ${parts.join(", ")}.`,
    });
  });

  revalidatePath(`/influencers/${post.campaignCreator.influencerId}`);
  revalidatePath(`/campaigns/${post.campaignCreator.campaignId}`);
  revalidatePath("/content");
  return { message: "Saved." };
}
