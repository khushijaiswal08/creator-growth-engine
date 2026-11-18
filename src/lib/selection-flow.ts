import type { CollaborationType, CreatorStatus } from "@prisma/client";
import { sealAddress } from "@/lib/address-crypto";
import { automationUserId, refreshNextAction } from "@/lib/automation";
import { db } from "@/lib/db";
import { describeRuleChecks } from "@/lib/gift-rules";
import { approvalChecks, giftableProductsWhere, normaliseCountry } from "@/lib/gifts";
import { TERMINAL_STATUSES } from "@/lib/next-action";
import { describeProduct } from "@/lib/product-list";
import { selectionLinkExpired } from "@/lib/selection";
import { statusChangeText } from "@/lib/status";

const LIMITS = { shipName: 100, address1: 150, address2: 150, city: 80, state: 60, postalCode: 20, country: 60, phone: 30, note: 500 };

export type SelectionValues = {
  shipName: string;
  address1: string;
  address2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string;
  note: string;
};

type SelectionResult =
  | { ok: false; error: string }
  | { ok: true; approved: boolean; campaignId: string; influencerId: string };

// Worded like the page a spent link opens on: a creator who confirmed in another tab is told their choice is in.
const LINK_INACTIVE ="This link is no longer active. If you have already chosen your gift, your choice is in. Otherwise, reply to our message and we will send you a new one.";

/**
 * Records a creator's product choice and shipping address. The long random
 * token is what proves who is asking, so nothing else from the caller is
 * trusted: the link must be unexpired and unused, the product must be one the
 * campaign offers, and the order is only approved automatically when it passes
 * every rule in config/gift-rules.json. The link is spent once this succeeds.
 */
export async function recordSelection(token: string, productId: string, raw: SelectionValues, now = new Date()): Promise<SelectionResult> {
  const creator = token
    ? await db.campaignCreator.findUnique({
        where: { selectionToken: token },
        include: {
          campaign: { select: { id: true, name: true, brandId: true, giftArticles: true, status: true } },
          influencer: { select: { id: true, archived: true } },
          giftOrders: { where: { status: { not: "cancelled" } }, select: { id: true } },
        },
      })
    : null;
  if (!creator || creator.influencer.archived || creator.campaign.status === "archived" || selectionLinkExpired(creator, now)) {
    return { ok: false, error: LINK_INACTIVE };
  }
  if (TERMINAL_STATUSES.has(creator.status)) {
    return { ok: false, error: "This link is no longer active. Please reply to our message and we will help." };
  }
  if (creator.giftOrders.length > 0) {
    return { ok: false, error: "You have already made your choice. Reply to our message if you need to change it." };
  }
  return saveGiftChoice(creator, productId, raw, { actor: await automationUserId(), by: null }, now);
}

/** Thrown inside the write when another gift for the same creator got in first; rolls the write back. */
class GiftAlreadyChosen extends Error {}

type ChoosingCreator = {
  id: string;
  influencerId: string;
  status: CreatorStatus;
  collaborationType: CollaborationType | null;
  approvedFee: number | null;
  selectionSentAt: Date | null;
  campaign: { id: string; brandId: string; giftArticles: string[] };
};

/**
 * What a gift choice goes through, whoever records it: the creator on their link, or a
 * person typing in what the creator sent by message. The same address checks, the same
 * product check, the same approval rules and the same encryption apply either way, and
 * either way the creator's selection link is spent, so a second gift cannot follow.
 * `by` is the person who typed it in (null when the creator used their link).
 */
export async function saveGiftChoice(
  creator: ChoosingCreator,
  productId: string,
  raw: SelectionValues,
  who: { actor: string; by: { name: string } | null },
  now = new Date(),
): Promise<SelectionResult> {
  const values = { ...raw, country: normaliseCountry(raw.country) };
  for (const key of ["shipName", "address1", "city", "state", "postalCode", "country"] as const) {
    if (!values[key]) return { ok: false, error: who.by ? "Fill in the name and the full shipping address." : "Please fill in your name and full shipping address." };
  }
  for (const [key, max] of Object.entries(LIMITS)) {
    if (values[key as keyof SelectionValues].length > max) return { ok: false, error: "One of the fields is too long." };
  }
  if (values.phone && !/^[0-9+()\-.\s]{7,30}$/.test(values.phone)) return { ok: false, error: "Please check the phone number." };

  // The product must be one this campaign actually offers, whatever the form says.
  const product = await db.product.findFirst({
    where: { id: productId, ...giftableProductsWhere(creator.campaign) },
    select: { id: true, title: true, color: true, size: true, sku: true, price: true },
  });
  if (!product) return { ok: false, error: who.by ? "That product is not offered in this campaign. Choose another." : "That product is no longer available. Please choose another." };

  const checks = await approvalChecks({
    influencerId: creator.influencerId,
    country: values.country,
    quantity: 1,
    productPriceUsd: product.price === null ? null : Number(product.price),
    collaborationType: creator.collaborationType,
    approvedFee: creator.approvedFee,
  });
  const failed = checks.filter((check) => !check.passed);
  const approved = failed.length === 0;
  const { actor } = who;
  const automated = who.by === null;
  const productLabel = describeProduct(product);
  const how = who.by
    ? `${who.by.name} entered the gift by hand from the creator's message: ${productLabel} (SKU ${product.sku}) and a shipping address.`
    : `the creator chose ${productLabel} (SKU ${product.sku}) and gave a shipping address.`;

  // Personal details are encrypted before they are written.
  const address = sealAddress({
    shipName: values.shipName,
    address1: values.address1,
    address2: values.address2 || null,
    city: values.city,
    state: values.state,
    postalCode: values.postalCode,
    phone: values.phone || null,
  });

  const created = await db.$transaction(async (tx) => {
    // The creator's row is written FIRST, which locks it until this transaction ends. A second
    // writer for the same creator (the creator on their link while a person enters the gift by
    // hand, or two people at once) waits here, and once the first one has committed it sees that
    // gift below and stops. Checking before the transaction alone would let both through.
    // The link is spent: the token is dropped so the same address never answers twice.
    await tx.campaignCreator.update({
      where: { id: creator.id },
      data: { status: "address_collected", selectionSentAt: creator.selectionSentAt ?? now, selectionToken: null, selectionUsedAt: now },
    });
    if ((await tx.giftOrder.count({ where: { campaignCreatorId: creator.id, status: { not: "cancelled" } } })) > 0) {
      throw new GiftAlreadyChosen();
    }
    await tx.giftOrder.create({
      data: {
        campaignCreatorId: creator.id,
        productId: product.id,
        quantity: 1,
        status: approved ? "approved" : "needs_approval",
        ...address,
        country: values.country,
        creatorNote: values.note || null,
        approvalNote: approved ? null : failed.map((check) => check.reason).join(" "),
        approvedById: approved ? actor : null,
        approvedAt: approved ? now : null,
      },
    });
    await tx.activity.createMany({
      data: [
        {
          userId: actor,
          automated,
          campaignCreatorId: creator.id,
          influencerId: creator.influencerId,
          kind: "status_change",
          body: `${statusChangeText(creator.status, "address_collected")}: ${how}`,
        },
        {
          userId: actor,
          automated,
          campaignCreatorId: creator.id,
          influencerId: creator.influencerId,
          kind: "note",
          body: `Gift order ${approved ? "approved automatically" : "needs a person"}. ${describeRuleChecks(checks)}`,
        },
      ],
    });
    return true;
  }).catch((error: unknown) => {
    if (error instanceof GiftAlreadyChosen) return false;
    throw error;
  });
  if (!created) {
    return { ok: false, error: who.by ? "This creator already has a gift. Open it in Gifts instead." : "You have already made your choice. Reply to our message if you need to change it." };
  }
  await refreshNextAction(creator.id, now);

  return { ok: true, approved, campaignId: creator.campaign.id, influencerId: creator.influencerId };
}
