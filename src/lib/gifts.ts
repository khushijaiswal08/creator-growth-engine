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

/** Orders still in flight: not delivered and not cancelled. */
export const OPEN_GIFT_STATUSES: ReadonlySet<GiftOrderStatus> = new Set(["needs_approval", "approved", "ordered", "shipped", "exception"]);

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
export async function approvalChecks(
  order: {
    influencerId: string;
    country: string;
    quantity: number;
    productPriceUsd: number | null;
    collaborationType: string | null;
    approvedFee: number | null;
  },
  /** When re-checking an order that already exists: leave it out of the "earlier gift" lookup and judge it as of its own date. */
  existing?: { id: string; createdAt: Date },
): Promise<RuleCheck[]> {
  const earlier = await db.giftOrder.findFirst({
    where: { status: { not: "cancelled" }, campaignCreator: { influencerId: order.influencerId }, ...(existing ? { id: { not: existing.id }, createdAt: { lt: existing.createdAt } } : {}) },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return checkGiftRules({ ...order, lastGiftAt: earlier?.createdAt ?? null, now: existing?.createdAt ?? new Date() });
}

type StoredOrderFacts = Parameters<typeof approvalChecks>[0] & { id: string; createdAt: Date };

/**
 * approvalChecks for many existing orders at once, keyed by order id: one query
 * for everyone's earlier gifts instead of one per order. Each order gets the same
 * "earlier gift" as approvalChecks(order, existing) would find. Like that lookup,
 * it counts gifts from every brand on purpose.
 */
export async function approvalChecksForOrders(orders: StoredOrderFacts[]): Promise<Map<string, RuleCheck[]>> {
  const checks = new Map<string, RuleCheck[]>();
  if (orders.length === 0) return checks;
  const gifts = await db.giftOrder.findMany({
    where: { status: { not: "cancelled" }, campaignCreator: { influencerId: { in: [...new Set(orders.map((order) => order.influencerId))] } } },
    select: { id: true, createdAt: true, campaignCreator: { select: { influencerId: true } } },
  });
  for (const { id, createdAt, ...order } of orders) {
    let lastGiftAt: Date | null = null;
    for (const gift of gifts) {
      if (gift.campaignCreator.influencerId !== order.influencerId || gift.id === id || gift.createdAt >= createdAt) continue;
      if (!lastGiftAt || gift.createdAt > lastGiftAt) lastGiftAt = gift.createdAt;
    }
    checks.set(id, checkGiftRules({ ...order, lastGiftAt, now: createdAt }));
  }
  return checks;
}

/** Short reference used as the order id in the Amazon bulk file, so tracking can be matched back. */
export function giftReference(id: string): string {
  return `CGE-${id.slice(-10).toUpperCase()}`;
}

/**
 * The phone number as it goes into the Amazon file. The CSV writer puts an apostrophe before a value that
 * starts with "+", so a spreadsheet does not run it as a formula; Amazon would then receive "'+1 512...".
 * Dropping the leading "+" keeps the number (country code included) and needs no apostrophe.
 */
export function amazonPhoneNumber(phone: string | null): string | null {
  const plain = phone?.trim().replace(/^\+\s*/, "") ?? "";
  return plain || null;
}

type PriceLike = { toNumber(): number } | number | null;
type PricedGift = { quantity: number; product: { price: PriceLike }; lines?: { quantity: number; product: { price: PriceLike } }[] };
const priceOf = (price: PriceLike): number | null => (price === null ? null : typeof price === "number" ? price : price.toNumber());

/**
 * Every product of a gift with its units. Gifts with several products (from 19 Nov 2026) carry
 * `lines`; older gifts hold one product on the gift itself.
 */
export function giftItems<T extends PricedGift>(gift: T): { product: T["product"]; quantity: number }[] {
  return gift.lines && gift.lines.length > 0 ? gift.lines.map((line) => ({ product: line.product as T["product"], quantity: line.quantity })) : [{ product: gift.product, quantity: gift.quantity }];
}

/** What the whole gift is worth at Amazon prices: every product times its units. Null when no product has a price. */
export function giftValueUsd(gift: PricedGift): number | null {
  let total: number | null = null;
  for (const item of giftItems(gift)) {
    const price = priceOf(item.product.price);
    if (price !== null) total = (total ?? 0) + price * item.quantity;
  }
  return total;
}
