/**
 * The brands this portal serves. A campaign belongs to exactly one.
 *
 * amazonNames: how the brand is written on its Amazon listings.
 * otherLabels: other labels sold from the same Amazon account. Their listings
 * are kept in the product list but are not offered to creators unless someone
 * switches them on.
 */
export const BRANDS = [
  { id: "ridhi", name: "Ridhi Block Print", short: "Ridhi", amazonNames: ["ridhi"], otherLabels: ["fabricrush"] },
  { id: "cotton-print-club", name: "Cotton Print Club", short: "CPC", amazonNames: ["cpc", "cotton print club"], otherLabels: [] },
] as const;

export type BrandId = (typeof BRANDS)[number]["id"];

export const DEFAULT_BRAND: BrandId = "ridhi";

export function isBrandId(value: string): value is BrandId {
  return BRANDS.some((brand) => brand.id === value);
}

export function brandName(id: string): string {
  return BRANDS.find((brand) => brand.id === id)?.name ?? id;
}

/** A few letters for tight spaces, such as the narrow sidebar. */
export function brandShortName(id: string): string {
  return BRANDS.find((brand) => brand.id === id)?.short ?? id;
}

function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}

/**
 * Whether an Amazon listing is sold under this brand's own name. Amazon's
 * brand field decides when it is filled in; the listing name is the fallback.
 */
export function isOwnLabel(brandId: BrandId, listing: { brandName: string; name: string }): boolean {
  const brand = BRANDS.find((candidate) => candidate.id === brandId);
  if (!brand) return false;
  const named = brand.amazonNames.some((word) => hasWord(listing.brandName || listing.name, word));
  const other = brand.otherLabels.some((word) => hasWord(listing.brandName, word) || hasWord(listing.name, word));
  return named && !other;
}
