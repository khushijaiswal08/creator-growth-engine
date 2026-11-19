"use server";

import type { Platform } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity";
import { sealAddress } from "@/lib/address-crypto";
import { allowed } from "@/lib/brand-scope";
import { db, isUniqueViolation } from "@/lib/db";
import { parseProfileUrl, profileLabel } from "@/lib/profile-url";
import { field, type FormState } from "@/lib/form";
import { giftableProductsWhere } from "@/lib/gifts";
import { TERMINAL_STATUSES } from "@/lib/next-action";
import { isEmail } from "@/lib/csv";
import { checkAddress, MAX_LINES, saveGiftChoice, type GiftItem } from "@/lib/selection-flow";
import { requireUser } from "@/lib/session";
import { CREATOR_STATUS_LABELS } from "@/lib/status";
import { loadSuppressions } from "@/lib/suppression";
import { distinctLabels, productLabel } from "@/lib/template";

/** One product the gift forms can add, found by its title, SKU or ASIN. */
export type GiftProductOption = { id: string; type: string; label: string; sku: string; asin: string | null };

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
  return { ok: true, products: distinctLabels(rows.map((row) => ({ id: row.id, sku: row.sku, asin: row.asin, type: row.title, label: productLabel(row) }))).map(({ id, type, label, sku, asin }) => ({ id, type, label, sku, asin })) };
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
  const items = itemsFrom(formData);
  if (items.length === 0) return { error: "Add at least one product." };
  const productIds = new Set(items.map((item) => item.productId));
  const offered = await db.product.count({ where: { id: { in: [...productIds] }, ...giftableProductsWhere(campaign) } });
  if (offered !== productIds.size) return { error: "A product is not offered in this campaign. Remove it or choose another." };
  const email = field(formData, "email").toLowerCase();
  if (email && !isEmail(email)) return { error: "The email address is not valid." };
  // Before any creator row is written: the handle or the typed email may be on the do-not-contact list.
  const blocked = await doNotContact(email, [{ platform, handle }]);
  if (blocked) return { error: blocked };

  const creatorName = field(formData, "creatorName") || handle;
  let campaignCreatorId: string;
  try {
    campaignCreatorId = await db.$transaction(async (tx) => {
      const existing = await tx.socialProfile.findUnique({ where: { platform_handle: { platform, handle } }, select: { influencerId: true } });
      let influencerId = existing?.influencerId;
      if (!influencerId) {
        const influencer = await tx.influencer.create({
          data: { name: creatorName.slice(0, 120), email: email || null, profiles: { create: { platform, handle, source: "manual" } } },
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
    items,
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
  await keepEmail(loaded.creator.influencerId, email);
  return { message: `Saved and approved. The gift for ${profileLabel(platform, handle)} is under To order: open it to create the order in the ERP.` };
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
  const email = field(formData, "email").toLowerCase();
  if (email && !isEmail(email)) return { error: "The email address is not valid." };
  // The email typed here may be on the do-not-contact list even when the creator's record has none yet.
  const blocked = await doNotContact(email, creator.influencer.profiles);
  if (blocked) return { error: blocked };

  const result = await saveGiftChoice(
    creator,
    itemsFrom(formData),
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

  await keepEmail(creator.influencerId, email);
  revalidatePath(`/influencers/${creator.influencerId}`);
  revalidatePath("/orders");
  revalidatePath("/today");
  return { message: "Saved and approved. Open it in Gifts to create the order in the ERP." };
}

/** The products and units a gift form sent: rows of itemProductId with itemUnits, in order. */
function itemsFrom(formData: FormData): GiftItem[] {
  const ids = formData.getAll("itemProductId").map(String);
  const units = formData.getAll("itemUnits").map(String);
  return ids
    .map((productId, index) => ({ productId: productId.trim(), quantity: Number(units[index] ?? "1") }))
    .filter((item) => item.productId)
    .slice(0, MAX_LINES * 2);
}

/** Why this email or profile may not be gifted (the do-not-contact list), or null. */
async function doNotContact(email: string, profiles: { platform: Platform; handle: string }[]): Promise<string | null> {
  const target = { email: email || null, profiles };
  const reason = (await loadSuppressions([target])).reasonFor(target);
  return reason ? `On the do-not-contact list: ${reason}` : null;
}

/** The email the creator gave, kept on their record only when it has none yet (never overwritten). */
async function keepEmail(influencerId: string, email: string) {
  if (!email) return;
  await db.influencer.updateMany({ where: { id: influencerId, email: null }, data: { email } });
}

/** Gift statuses whose address may still be changed here: nothing has been ordered yet. */
const EDITABLE_GIFT_STATUSES = ["needs_approval", "approved"] as const;

/**
 * "Edit address" in the gift drawer: fixes a typo or a wrong state before the order leaves.
 * Only for a gift of this person's brand that has not gone to the ERP or Amazon; after that the
 * order lives there and is changed there. The same address rules as the forms apply, the address
 * stays encrypted, the ERP's last refusal is cleared so the order can be sent again, and the
 * history says who changed it (without the address itself).
 */
export async function editGiftAddress(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  const giftId = field(formData, "giftId");
  const gift = await db.giftOrder.findFirst({
    where: { id: giftId, ...allowed(user).gifts },
    select: { id: true, status: true, erpSentAt: true, mcfSentAt: true, campaignCreator: { select: { id: true, influencerId: true, campaignId: true } } },
  });
  if (!gift) return { error: "Gift order not found." };
  const sent = gift.erpSentAt !== null || gift.mcfSentAt !== null || !(EDITABLE_GIFT_STATUSES as readonly string[]).includes(gift.status);
  if (sent) return { error: "This gift has already gone to the ERP or Amazon. Change the address there." };

  const checked = checkAddress(
    {
      shipName: field(formData, "shipName"),
      address1: field(formData, "address1"),
      address2: field(formData, "address2"),
      city: field(formData, "city"),
      state: field(formData, "state"),
      postalCode: field(formData, "postalCode"),
      country: field(formData, "country"),
      phone: field(formData, "phone"),
      note: "",
    },
    true,
  );
  if (!checked.ok) return { error: checked.error };
  const { values } = checked;

  // Written only if it is still unsent: someone may have pressed "Create order in ERP" meanwhile.
  const changed = await db.$transaction(async (tx) => {
    const { count } = await tx.giftOrder.updateMany({
      where: { id: gift.id, erpSentAt: null, mcfSentAt: null, status: { in: [...EDITABLE_GIFT_STATUSES] } },
      data: {
        ...sealAddress({ shipName: values.shipName, address1: values.address1, address2: values.address2 || null, city: values.city, state: values.state, postalCode: values.postalCode, phone: values.phone || null }),
        country: values.country,
        erpError: null,
      },
    });
    if (count === 0) return false;
    await logActivity(tx, { userId: user.id, kind: "note", campaignCreatorId: gift.campaignCreator.id, influencerId: gift.campaignCreator.influencerId, body: `Shipping address of the gift order edited by ${user.name}.` });
    return true;
  });
  if (!changed) return { error: "This gift has just gone to the ERP or Amazon. Change the address there." };

  revalidatePath("/orders");
  revalidatePath(`/influencers/${gift.campaignCreator.influencerId}`);
  revalidatePath(`/campaigns/${gift.campaignCreator.campaignId}`);
  return { message: "Address saved." };
}
