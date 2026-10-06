import type { Prisma } from "@prisma/client";
import { isBrandId } from "@/lib/brands";
import type { StatusTone } from "@/lib/status";

/**
 * Whether creators are shown a product, and if not, why.
 * This file is the one place that decides it: the same rules are written once
 * for a product in hand (offerStatus) and once as database filters
 * (OFFER_STATUS_WHERE), and a test keeps the two in step.
 */
export type OfferStatus = "offered" | "not_offered" | "sold_out" | "nothing_to_show" | "not_live";

export const OFFER_STATUSES = ["offered", "not_offered", "nothing_to_show", "sold_out", "not_live"] as const satisfies readonly OfferStatus[];

export const OFFER_STATUS_LABELS: Record<OfferStatus, string> = {
  offered: "Offered to creators",
  not_offered: "Not offered",
  sold_out: "Sold out",
  nothing_to_show: "No link or photo",
  not_live: "Not live on Amazon",
};

export const OFFER_STATUS_TONES: Record<OfferStatus, StatusTone> = {
  offered: "success",
  not_offered: "warning",
  sold_out: "danger",
  nothing_to_show: "warning",
  not_live: "neutral",
};

type Offerable = {
  archived: boolean;
  giftable: boolean;
  stock: number | null;
  imageUrl: string | null;
  amazonUrl: string | null;
  websiteUrl: string | null;
};

/** The first reason that applies is the one shown. */
export function offerStatus(product: Offerable): OfferStatus {
  if (product.archived) return "not_live";
  if (!product.giftable) return "not_offered";
  if (product.stock === 0) return "sold_out";
  // A creator must be able to see what they are choosing.
  if (!product.imageUrl && !product.amazonUrl && !product.websiteUrl) return "nothing_to_show";
  return "offered";
}

const IN_STOCK_OR_UNKNOWN: Prisma.ProductWhereInput = { OR: [{ stock: null }, { stock: { gt: 0 } }] };
const SOMETHING_TO_SHOW: Prisma.ProductWhereInput = {
  OR: [{ imageUrl: { not: null } }, { amazonUrl: { not: null } }, { websiteUrl: { not: null } }],
};

export const OFFER_STATUS_WHERE: Record<OfferStatus, Prisma.ProductWhereInput> = {
  not_live: { archived: true },
  not_offered: { archived: false, giftable: false },
  sold_out: { archived: false, giftable: true, stock: 0 },
  nothing_to_show: { archived: false, giftable: true, AND: [IN_STOCK_OR_UNKNOWN, { NOT: SOMETHING_TO_SHOW }] },
  offered: { archived: false, giftable: true, AND: [IN_STOCK_OR_UNKNOWN, SOMETHING_TO_SHOW] },
};

export function isOfferStatus(value: string): value is OfferStatus {
  return (OFFER_STATUSES as readonly string[]).includes(value);
}

/** What the Products screen is narrowed to: search words, one brand, one status. Empty strings mean "any". */
export type ProductListFilter = { q: string; brand: string; view: string };

export function productListWhere(filter: ProductListFilter): Prisma.ProductWhereInput {
  const and: Prisma.ProductWhereInput[] = [];
  // Every word must appear somewhere, so "sage tablecloth" finds sage green tablecloths.
  for (const word of filter.q.split(/\s+/).filter(Boolean).slice(0, 6)) {
    const contains = { contains: word, mode: "insensitive" as const };
    and.push({ OR: [{ sku: contains }, { asin: contains }, { title: contains }, { listingName: contains }, { color: contains }, { size: contains }] });
  }
  if (isBrandId(filter.brand)) and.push({ brandId: filter.brand });
  if (isOfferStatus(filter.view)) and.push(OFFER_STATUS_WHERE[filter.view]);
  return { AND: and };
}

export function isFiltered(filter: ProductListFilter): boolean {
  return filter.q.trim() !== "" || isBrandId(filter.brand) || isOfferStatus(filter.view);
}
