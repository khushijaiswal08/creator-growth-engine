import type { GiftOrderStatus, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { checkGiftRules, GIFT_RULES, type RuleCheck } from "@/lib/gift-rules";
import { OFFER_STATUS_WHERE } from "@/lib/product-list";
import type { StatusTone } from "@/lib/status";

export const GIFT_STATUS_LABELS: Record<GiftOrderStatus, string> = {
  needs_approval: "Needs approval",
  approved: "Approved, to order",
  ordered: "Ordered",
  shipped: "Shipped",
  delivered: "Delivered",
  exception: "Shipping problem",
  cancelled: "Cancelled",
};

export const GIFT_STATUS_TONES: Record<GiftOrderStatus, StatusTone> = {
  needs_approval: "warning",
  approved: "primary",
  ordered: "warning",
  shipped: "warning",
  delivered: "success",
  exception: "danger",
  cancelled: "neutral",
};

export const GIFT_STATUSES = Object.keys(GIFT_STATUS_LABELS) as GiftOrderStatus[];

/** A second gift to the same person inside this window needs a person to agree. From config/gift-rules.json. */
export const REPEAT_GIFT_DAYS = GIFT_RULES.repeatGiftDays;

const US_NAMES = new Set(["us", "usa", "u.s.", "u.s.a.", "united states", "united states of america", "america"]);

/** "usa" -> "United States". Other countries are kept as typed. */
export function normaliseCountry(raw: string): string {
  const clean = raw.trim();
  return US_NAMES.has(clean.toLowerCase()) ? "United States" : clean;
}

/** "Decorative_Pillow_Cover" -> "Decorative Pillow Cover". */
export function tidyTitle(raw: string): string {
  return raw.replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

export function amazonUrlFor(asin: string | null): string | null {
  return asin ? `https://www.amazon.com/dp/${asin}` : null;
}

/**
 * Products a creator in this campaign may choose: the brand's products that
 * are offered (live on Amazon, switched on, not sold out, with a link or photo
 * to look at), narrowed to the campaign's product types when it names any.
 */
export function giftableProductsWhere(campaign: { brandId: string; giftArticles: string[] }): Prisma.ProductWhereInput {
  return {
    ...OFFER_STATUS_WHERE.offered,
    brandId: campaign.brandId,
    ...(campaign.giftArticles.length > 0 ? { title: { in: campaign.giftArticles } } : {}),
  };
}

/**
 * Applies the auto-approval rules (config/gift-rules.json) to one order and
 * says which passed and which failed. Every check is listed, so the activity
 * log can name the rules an order was approved under.
 */
export async function approvalChecks(order: {
  influencerId: string;
  country: string;
  quantity: number;
  productPriceUsd: number | null;
  collaborationType: string | null;
  approvedFee: number | null;
}): Promise<RuleCheck[]> {
  const earlier = await db.giftOrder.findFirst({
    where: { status: { not: "cancelled" }, campaignCreator: { influencerId: order.influencerId } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return checkGiftRules({ ...order, lastGiftAt: earlier?.createdAt ?? null, now: new Date() });
}

/** The reasons an order needs a person; an empty list means it is within the rules. */
export async function approvalReasons(order: Parameters<typeof approvalChecks>[0]): Promise<string[]> {
  return (await approvalChecks(order)).filter((check) => !check.passed).map((check) => check.reason!);
}

/** Short reference used as the order id in the Amazon bulk file, so tracking can be matched back. */
export function giftReference(id: string): string {
  return `CGE-${id.slice(-10).toUpperCase()}`;
}
