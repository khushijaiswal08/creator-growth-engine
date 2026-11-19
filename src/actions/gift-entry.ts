"use server";

import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity";
import { allowed } from "@/lib/brand-scope";
import { db, isUniqueViolation } from "@/lib/db";
import { parseProfileUrl, profileLabel } from "@/lib/profile-url";
import { field, type FormState } from "@/lib/form";
import { giftableProductsWhere } from "@/lib/gifts";
import { TERMINAL_STATUSES } from "@/lib/next-action";
import { saveGiftChoice } from "@/lib/selection-flow";
import { requireUser } from "@/lib/session";
import { CREATOR_STATUS_LABELS } from "@/lib/status";
import { loadSuppressions } from "@/lib/suppression";
import { distinctLabels, productLabel } from "@/lib/template";

/** One product in the "Enter gift by hand" dropdowns, grouped by its type. */
export type GiftProductOption = { id: string; type: string; label: string; asin: string | null };

/**
 * The creator, if this person may enter a gift for them: in a campaign of the
 * person's brand, neither the creator nor the campaign archived, not finished,
 * not on the do-not-contact list, and with no gift already in progress.
 */
async function loadGiftable(campaignCreatorId: string) {
  const user = await requireUser();
  const creator = await db.campaignCreator.findFirst({
    where: { id: campaignCreatorId, ...allowed(user).creators },
    select: {
      id: true,
      influencerId: true,
      status: true,
      collaborationType: true,
      approvedFee: true,
      selectionSentAt: true,
      campaign: { select: { id: true, brandId: true, giftArticles: true, status: true } },
      influencer: { select: { id: true, archived: true, email: true, profiles: { select: { platform: true, handle: true } } } },
      giftOrders: { where: { status: { not: "cancelled" } }, select: { id: true } },
    },
  });
  if (!creator) return { ok: false as const, error: "This creator is no longer in the campaign." };
  if (creator.influencer.archived) return { ok: false as const, error: "This creator is archived." };
  if (creator.campaign.status === "archived") return { ok: false as const, error: "This campaign is archived." };
  if (TERMINAL_STATUSES.has(creator.status)) {
    return { ok: false as const, error: `This creator is marked ${CREATOR_STATUS_LABELS[creator.status]}. Change their status first if they really are getting a gift.` };
  }
  if (creator.giftOrders.length > 0) return { ok: false as const, error: "This creator already has a gift. Open it in Gifts instead." };
  const suppressed = (await loadSuppressions([creator.influencer])).reasonFor(creator.influencer);
  if (suppressed) return { ok: false as const, error: `On the do-not-contact list: ${suppressed}` };
  return { ok: true as const, user, creator };
}

type ProductList = { ok: true; products: GiftProductOption[] } | { ok: false; error: string };

/** What a campaign offers as gifts, labelled for the dropdowns: the same list as the creator's link shows. */
async function giftProductsOf(campaign: { brandId: string; giftArticles: string[] }): Promise<ProductList> {
  const rows = await db.product.findMany({
    where: giftableProductsWhere(campaign),
    select: { id: true, sku: true, asin: true, title: true, color: true, size: true, listingName: true },
    orderBy: [{ title: "asc" }, { color: "asc" }, { size: "asc" }, { sku: "asc" }],
    take: 3000,
  });
  if (rows.length === 0) return { ok: false, error: "This campaign offers no products right now. Check its Settings tab." };
  return { ok: true, products: distinctLabels(rows.map((row) => ({ id: row.id, sku: row.sku, asin: row.asin, type: row.title, label: productLabel(row) }))).map(({ id, type, label, asin }) => ({ id, type, label, asin })) };
}

/** The products this creator's campaign offers, for the two dropdowns, or why no gift can be entered. */
export async function productsForGift(campaignCreatorId: string): Promise<ProductList> {
  const loaded = await loadGiftable(campaignCreatorId);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return giftProductsOf(loaded.creator.campaign);
}

/** A campaign of this person's brand that can take a new gift (not archived). */
async function loadOpenCampaign(campaignId: string) {
  const user = await requireUser();
  const campaign = campaignId
    ? await db.campaign.findFirst({
        where: { id: campaignId, ...allowed(user).campaigns, status: { not: "archived" } },
        select: { id: true, name: true, brandId: true, giftArticles: true },
      })
    : null;
  return { user, campaign };
}

/** The products a campaign offers, for "Gift a creator" on the Gifts page. */
export async function productsForCampaign(campaignId: string): Promise<ProductList> {
  const { campaign } = await loadOpenCampaign(campaignId);
  if (!campaign) return { ok: false, error: "Choose a campaign." };
  return giftProductsOf(campaign);
}

/** "@handle", "handle" or a profile link -> the Instagram (or other) profile, as the portal stores it. */
function profileFromInput(raw: string) {
  const text = raw.trim();
  if (!text) return { ok: false as const, error: "Type the creator's Instagram handle." };
  // Instagram handles may contain dots, so only a slash or a scheme makes it a link.
  const looksLikeLink = /^https?:\/\//i.test(text) || text.includes("/");
  return parseProfileUrl(looksLikeLink ? text : `https://www.instagram.com/${text.replace(/^@/, "")}/`);
}

/**
 * "Gift a creator" on the Gifts page: straight to a gift, with no discovery or outreach
 * step, for testing a shipment or for a creator the team arranged elsewhere. The creator
 * is found by handle (or added once), put in the chosen campaign, and the gift then goes
 * through exactly what a link or a hand-entered gift does: every check in loadGiftable,
 * then saveGiftChoice with its rules, encryption and one-gift limit.
 */
export async function giftNewCreator(_prev: FormState, formData: FormData): Promise<FormState> {
  if (field(formData, "confirm") !== "yes") return { error: "Tick the box to confirm the creator sent these details for this gift." };
  const { user, campaign } = await loadOpenCampaign(field(formData, "campaignId"));
  if (!campaign) return { error: "Choose a campaign of your brand that is not archived." };

  const parsed = profileFromInput(field(formData, "handle"));
  if (!parsed.ok) return { error: parsed.error };
  const { platform, handle } = parsed.profile;

  // Checked before anything is written, so a mistake leaves no half-made creator behind.
  for (const key of ["shipName", "address1", "city", "state", "postalCode", "country"]) {
    if (!field(formData, key)) return { error: "Fill in the name and the full shipping address." };
  }
  const productId = field(formData, "productId");
  if (!(await db.product.findFirst({ where: { id: productId, ...giftableProductsWhere(campaign) }, select: { id: true } }))) {
    return { error: "That product is not offered in this campaign. Choose another." };
  }

  const creatorName = field(formData, "creatorName") || handle;
  let campaignCreatorId: string;
  try {
    campaignCreatorId = await db.$transaction(async (tx) => {
      const existing = await tx.socialProfile.findUnique({ where: { platform_handle: { platform, handle } }, select: { influencerId: true } });
      let influencerId = existing?.influencerId;
      if (!influencerId) {
        const influencer = await tx.influencer.create({
          data: { name: creatorName.slice(0, 120), profiles: { create: { platform, handle, source: "manual" } } },
        });
        influencerId = influencer.id;
        await logActivity(tx, { userId: user.id, kind: "influencer_created", influencerId, body: `Added from Gifts by ${user.name} (${profileLabel(platform, handle)}).` });
      }
      const inCampaign = await tx.campaignCreator.findUnique({ where: { campaignId_influencerId: { campaignId: campaign.id, influencerId } }, select: { id: true } });
      if (inCampaign) return inCampaign.id;
      const created = await tx.campaignCreator.create({ data: { campaignId: campaign.id, influencerId, ownerId: user.id } });
      await logActivity(tx, { userId: user.id, kind: "added_to_campaign", campaignCreatorId: created.id, influencerId, body: `Added to campaign "${campaign.name}" from Gifts, to be gifted directly.` });
      return created.id;
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { error: `${profileLabel(platform, handle)} was just added by someone else. Try again.` };
    throw error;
  }

  // From here it is the same path as "Enter gift by hand" on the creator's page.
  const loaded = await loadGiftable(campaignCreatorId);
  if (!loaded.ok) return { error: loaded.error };
  const result = await saveGiftChoice(
    loaded.creator,
    productId,
    {
      shipName: field(formData, "shipName"),
      address1: field(formData, "address1"),
      address2: field(formData, "address2"),
      city: field(formData, "city"),
      state: field(formData, "state"),
      postalCode: field(formData, "postalCode"),
      country: field(formData, "country"),
      phone: field(formData, "phone"),
      note: field(formData, "note"),
    },
    { actor: user.id, by: { name: user.name } },
  );
  if (!result.ok) return { error: result.error };

  revalidatePath("/orders");
  revalidatePath(`/influencers/${loaded.creator.influencerId}`);
  revalidatePath(`/campaigns/${campaign.id}`);
  revalidatePath("/today");
  return {
    message: result.approved
      ? `Saved. The gift for ${profileLabel(platform, handle)} passed every rule and is under To order: open it to create the order in the ERP.`
      : `Saved. The gift for ${profileLabel(platform, handle)} waits under Needs approval, with the reason.`,
  };
}

/**
 * A person records the gift a creator asked for in a DM or email, instead of
 * the creator using their link. It goes through exactly what the link does
 * (saveGiftChoice): same checks, same approval rules, address encrypted, link
 * spent. The person confirms the creator sent these details themselves.
 */
export async function enterGiftByHand(_prev: FormState, formData: FormData): Promise<FormState> {
  if (field(formData, "confirm") !== "yes") return { error: "Tick the box to confirm the creator sent these details for this gift." };
  const loaded = await loadGiftable(field(formData, "campaignCreatorId"));
  if (!loaded.ok) return { error: loaded.error };
  const { user, creator } = loaded;

  const result = await saveGiftChoice(
    creator,
    field(formData, "productId"),
    {
      shipName: field(formData, "shipName"),
      address1: field(formData, "address1"),
      address2: field(formData, "address2"),
      city: field(formData, "city"),
      state: field(formData, "state"),
      postalCode: field(formData, "postalCode"),
      country: field(formData, "country"),
      phone: field(formData, "phone"),
      note: field(formData, "note"),
    },
    { actor: user.id, by: { name: user.name } },
  );
  if (!result.ok) return { error: result.error };

  revalidatePath(`/influencers/${creator.influencerId}`);
  revalidatePath("/orders");
  revalidatePath("/today");
  return {
    message: result.approved
      ? "Saved. The gift passed every rule and is approved: open it in Gifts to create the order in the ERP."
      : "Saved. The gift waits in Gifts under Needs approval, with the reason.",
  };
}
