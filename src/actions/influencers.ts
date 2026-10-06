"use server";

import { Prisma, type Platform } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity";
import { allowed } from "@/lib/brand-scope";
import { isEmail } from "@/lib/csv";
import { db } from "@/lib/db";
import { getCreatorSource, NotImplementedError, type ProfileData } from "@/lib/fetching";
import { field, optionalField, type FormState } from "@/lib/form";
import { displayHandle, parseProfileUrl, PLATFORM_LABELS } from "@/lib/profile-url";
import { requireUser } from "@/lib/session";

/** Asks the configured creator source for profile data; stub adapters fall back to manual entry. */
async function enrich(platform: Platform, handle: string): Promise<ProfileData> {
  try {
    return await getCreatorSource().enrichProfile(platform, handle);
  } catch (error) {
    if (error instanceof NotImplementedError) {
      return getCreatorSource("manual").enrichProfile(platform, handle);
    }
    throw error;
  }
}

function profileFields(data: ProfileData) {
  return {
    platform: data.platform,
    handle: data.handle,
    followers: data.followers,
    engagementRate: data.engagementRate,
    bio: data.bio,
    website: data.website,
    lastFetchedAt: data.fetchedAt,
    country: data.country,
    lastPostAt: data.lastPostAt,
    lastPostUrl: data.lastPostUrl,
    recentCaptions: data.recentCaptions,
    fetchNote: data.fetchNote,
    // Only a source that actually fetched something gets credit for the row.
    source: data.fetchedAt ? data.source : ("manual" as const),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** Adds the influencer to the campaign unless already there. Returns true when a row was created. */
async function attachToCampaign(
  tx: Prisma.TransactionClient,
  args: { campaignId: string; campaignName: string; influencerId: string; userId: string },
): Promise<boolean> {
  const existing = await tx.campaignCreator.findUnique({
    where: {
      campaignId_influencerId: { campaignId: args.campaignId, influencerId: args.influencerId },
    },
    select: { id: true },
  });
  if (existing) return false;

  const created = await tx.campaignCreator.create({
    data: { campaignId: args.campaignId, influencerId: args.influencerId, ownerId: args.userId },
  });
  await logActivity(tx, {
    userId: args.userId,
    kind: "added_to_campaign",
    campaignCreatorId: created.id,
    influencerId: args.influencerId,
    body: `Added to campaign "${args.campaignName}".`,
  });
  return true;
}

/** True when the creator is also in a campaign outside the given brand's campaigns. */
async function sharedWithAnotherBrand(influencerId: string, ownCreators: Prisma.CampaignCreatorWhereInput): Promise<boolean> {
  return (await db.campaignCreator.count({ where: { influencerId, NOT: ownCreators } })) > 0;
}

export async function addInfluencerByUrl(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();

  const parsed = parseProfileUrl(field(formData, "url"));
  if (!parsed.ok) return { error: parsed.error };
  const { platform, handle } = parsed.profile;

  const email = optionalField(formData, "email")?.toLowerCase() ?? null;
  if (email && !isEmail(email)) return { error: "Email is not valid." };

  const scope = allowed(user);
  const campaignId = optionalField(formData, "campaignId");
  const campaign = campaignId
    ? await db.campaign.findFirst({ where: { id: campaignId, ...scope.campaigns }, select: { id: true, name: true } })
    : null;
  if (campaignId && !campaign) return { error: "That campaign no longer exists." };
  // A creator belongs to a brand through a campaign. Without one, someone tied to a brand
  // would add a creator they could not see afterwards.
  if (!campaign && scope.brandId) return { error: "Choose a campaign, so the creator is added to your brand." };

  const existing = await db.socialProfile.findUnique({
    where: { platform_handle: { platform, handle } },
    select: { influencerId: true },
  });

  let influencerId: string;
  let notice = "";

  if (existing) {
    // One influencer exists once: reuse the record instead of creating a twin.
    influencerId = existing.influencerId;
    notice = "exists";
    if (campaign) {
      await db.$transaction((tx) =>
        attachToCampaign(tx, {
          campaignId: campaign.id,
          campaignName: campaign.name,
          influencerId,
          userId: user.id,
        }),
      );
    }
  } else {
    const data = await enrich(platform, handle);
    const label = `${PLATFORM_LABELS[platform]} ${displayHandle(handle)}`;
    try {
      influencerId = await db.$transaction(async (tx) => {
        const influencer = await tx.influencer.create({
          data: {
            name: optionalField(formData, "name") ?? data.name ?? handle,
            email: email ?? data.email,
            location: optionalField(formData, "location") ?? data.location,
            profiles: { create: profileFields(data) },
          },
        });
        await logActivity(tx, {
          userId: user.id,
          kind: "influencer_created",
          influencerId: influencer.id,
          body: `Created from profile URL (${label}).`,
        });
        if (campaign) {
          await attachToCampaign(tx, {
            campaignId: campaign.id,
            campaignName: campaign.name,
            influencerId: influencer.id,
            userId: user.id,
          });
        }
        return influencer.id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { error: `${label} was just added by someone else.` };
      throw error;
    }
  }

  revalidatePath("/influencers");
  if (campaign) revalidatePath(`/campaigns/${campaign.id}`);
  redirect(`/influencers/${influencerId}${notice ? `?notice=${notice}` : ""}`);
}

export async function addProfileToInfluencer(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const influencerId = field(formData, "influencerId");

  const parsed = parseProfileUrl(field(formData, "url"));
  if (!parsed.ok) return { error: parsed.error };
  const { platform, handle } = parsed.profile;
  const label = `${PLATFORM_LABELS[platform]} ${displayHandle(handle)}`;

  const scope = allowed(user);
  const influencer = await db.influencer.findFirst({ where: { id: influencerId, ...scope.influencers }, select: { id: true } });
  if (!influencer) return { error: "This influencer no longer exists." };

  // Handles are unique across both brands, so this lookup is deliberately not limited to one.
  const existing = await db.socialProfile.findUnique({
    where: { platform_handle: { platform, handle } },
    select: { influencerId: true },
  });
  if (existing) {
    if (existing.influencerId === influencerId) return { error: `${label} is already on this influencer.` };
    // Named only when this person may see them; otherwise it would give away the other brand's creator.
    const owner = await db.influencer.findFirst({ where: { id: existing.influencerId, ...scope.influencers }, select: { name: true } });
    return { error: owner ? `${label} already belongs to ${owner.name}.` : `${label} already belongs to another creator in the portal.` };
  }

  const data = await enrich(platform, handle);
  try {
    await db.$transaction(async (tx) => {
      await tx.socialProfile.create({ data: { influencerId, ...profileFields(data) } });
      await logActivity(tx, {
        userId: user.id,
        kind: "profile_added",
        influencerId,
        body: `Added profile ${label}.`,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { error: `${label} was just added by someone else.` };
    throw error;
  }

  revalidatePath(`/influencers/${influencerId}`);
  return { message: `Added ${label}.` };
}

export async function updateInfluencer(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const influencerId = field(formData, "influencerId");

  const name = field(formData, "name");
  if (!name) return { error: "Name is required." };
  if (name.length > 120) return { error: "Name is too long." };

  const email = optionalField(formData, "email")?.toLowerCase() ?? null;
  if (email && !isEmail(email)) return { error: "Email is not valid." };

  const rawSignal = field(formData, "usSignal");
  const usSignal = rawSignal ? Number(rawSignal) : null;
  if (usSignal !== null && (!Number.isInteger(usSignal) || usSignal < 0 || usSignal > 100)) {
    return { error: "US signal must be a whole number from 0 to 100." };
  }

  const next = {
    name,
    email,
    location: optionalField(formData, "location"),
    usSignal,
    notes: optionalField(formData, "notes"),
  };

  const current = await db.influencer.findFirst({ where: { id: influencerId, ...allowed(user).influencers } });
  if (!current) return { error: "This influencer no longer exists." };

  const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
    (key) => next[key] !== current[key],
  );
  if (changed.length === 0) return { message: "No changes to save." };

  await db.$transaction(async (tx) => {
    await tx.influencer.update({ where: { id: influencerId }, data: next });
    await logActivity(tx, {
      userId: user.id,
      kind: "influencer_updated",
      influencerId,
      body: `Edited ${changed.map((key) => (key === "usSignal" ? "US signal" : key)).join(", ")}.`,
    });
  });

  revalidatePath(`/influencers/${influencerId}`);
  revalidatePath("/influencers");
  return { message: "Saved." };
}

/** Creators are never hard-deleted; archiving hides them from the default list. */
export async function setInfluencerArchived(influencerId: string, archived: boolean): Promise<void> {
  const user = await requireUser();

  const scope = allowed(user);
  const current = await db.influencer.findFirst({
    where: { id: influencerId, ...scope.influencers },
    select: { archived: true },
  });
  if (!current || current.archived === archived) return;
  // Archiving hides the creator from everyone. Someone tied to one brand may not do that to a
  // creator the other brand also works with; a person who sees both brands can.
  if (scope.brandId && (await sharedWithAnotherBrand(influencerId, scope.creators))) return;

  await db.$transaction(async (tx) => {
    await tx.influencer.update({ where: { id: influencerId }, data: { archived } });
    await logActivity(tx, {
      userId: user.id,
      kind: archived ? "influencer_archived" : "influencer_unarchived",
      influencerId,
      body: archived ? "Archived." : "Restored from archive.",
    });
  });

  revalidatePath(`/influencers/${influencerId}`);
  revalidatePath("/influencers");
}

export async function addInfluencerToCampaign(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const influencerId = field(formData, "influencerId");
  const campaignId = field(formData, "campaignId");
  if (!campaignId) return { error: "Choose a campaign." };

  const scope = allowed(user);
  const [influencer, campaign] = await Promise.all([
    db.influencer.findFirst({ where: { id: influencerId, ...scope.influencers }, select: { id: true } }),
    db.campaign.findFirst({ where: { id: campaignId, ...scope.campaigns }, select: { id: true, name: true } }),
  ]);
  if (!influencer) return { error: "This influencer no longer exists." };
  if (!campaign) return { error: "That campaign no longer exists." };

  let created: boolean;
  try {
    created = await db.$transaction((tx) =>
      attachToCampaign(tx, {
        campaignId: campaign.id,
        campaignName: campaign.name,
        influencerId,
        userId: user.id,
      }),
    );
  } catch (error) {
    if (isUniqueViolation(error)) return { error: `Already in "${campaign.name}".` };
    throw error;
  }
  if (!created) return { error: `Already in "${campaign.name}".` };

  revalidatePath(`/influencers/${influencerId}`);
  revalidatePath(`/campaigns/${campaign.id}`);
  return { message: `Added to "${campaign.name}".` };
}
