"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { logActivity } from "@/lib/activity";
import { allowed } from "@/lib/brand-scope";
import { brandName, isBrandId } from "@/lib/brands";
import { db } from "@/lib/db";
import { field, splitKeywords, type FormState } from "@/lib/form";
import { requireUser } from "@/lib/session";
import { CAMPAIGN_STATUSES } from "@/lib/status";

const campaignSchema = z.object({
  name: z.string().min(2, "Name is required.").max(120, "Name is too long."),
  brandId: z.string().refine(isBrandId, "Choose a brand."),
  brief: z.string().min(1, "Brief is required.").max(10_000, "Brief is too long."),
  targetPosts: z.number().int().min(0).max(100_000).nullable(),
  deadline: z.date().nullable(),
  status: z.enum(CAMPAIGN_STATUSES),
});

export async function createCampaign(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();

  const rawTarget = field(formData, "targetPosts");
  const rawDeadline = field(formData, "deadline");
  const deadline = rawDeadline ? new Date(`${rawDeadline}T00:00:00Z`) : null;
  if (deadline && Number.isNaN(deadline.getTime())) return { error: "Deadline is not a valid date." };

  const parsed = campaignSchema.safeParse({
    name: field(formData, "name"),
    brandId: field(formData, "brandId"),
    brief: field(formData, "brief"),
    targetPosts: rawTarget ? Number(rawTarget) : null,
    deadline,
    status: field(formData, "status"),
  });
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  if (!allowed(user).includes(parsed.data.brandId)) {
    return { error: `You work on ${brandName(user.brandId ?? "")}, so you can only create campaigns for that brand.` };
  }

  // Names are unique across both brands, so this check is deliberately not limited to one.
  const existing = await db.campaign.findFirst({
    where: { name: { equals: parsed.data.name, mode: "insensitive" } },
    select: { id: true },
  });
  if (existing) return { error: "A campaign with this name already exists." };

  const campaign = await db.$transaction(async (tx) => {
    const created = await tx.campaign.create({
      data: {
        ...parsed.data,
        nicheKeywords: splitKeywords(field(formData, "nicheKeywords")),
        negativeKeywords: splitKeywords(field(formData, "negativeKeywords")),
      },
    });
    await logActivity(tx, {
      userId: user.id,
      kind: "campaign_created",
      body: `Created campaign "${created.name}".`,
    });
    return created;
  });

  revalidatePath("/campaigns");
  redirect(`/campaigns/${campaign.id}`);
}
