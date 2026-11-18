"use server";

import { revalidatePath } from "next/cache";
import { allowed } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import { field, type FormState } from "@/lib/form";
import { giftableProductsWhere } from "@/lib/gifts";
import { TERMINAL_STATUSES } from "@/lib/next-action";
import { saveGiftChoice } from "@/lib/selection-flow";
import { requireUser } from "@/lib/session";
import { CREATOR_STATUS_LABELS } from "@/lib/status";
import { loadSuppressions } from "@/lib/suppression";
import { distinctLabels, productLabel } from "@/lib/template";

/** One product in the "Enter gift by hand" dropdowns, grouped by its type. */
export type GiftProductOption = { id: string; type: string; label: string };

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

/** The products this creator's campaign offers, for the two dropdowns, or why no gift can be entered. */
export async function productsForGift(campaignCreatorId: string): Promise<{ ok: true; products: GiftProductOption[] } | { ok: false; error: string }> {
  const loaded = await loadGiftable(campaignCreatorId);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const rows = await db.product.findMany({
    where: giftableProductsWhere(loaded.creator.campaign),
    select: { id: true, sku: true, title: true, color: true, size: true, listingName: true },
    orderBy: [{ title: "asc" }, { color: "asc" }, { size: "asc" }, { sku: "asc" }],
    take: 3000,
  });
  if (rows.length === 0) return { ok: false, error: "This campaign offers no products right now. Check its Settings tab." };
  return { ok: true, products: distinctLabels(rows.map((row) => ({ id: row.id, sku: row.sku, type: row.title, label: productLabel(row) }))).map(({ id, type, label }) => ({ id, type, label })) };
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
