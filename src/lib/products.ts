import type { Prisma } from "@prisma/client";
import Papa from "papaparse";
import { z } from "zod";
import { categoryFor, colourSpellings, isAmazonCopy, listingKind, type AmazonListing, type ListingKind } from "@/lib/amazon-listing";
import { BRANDS, brandName, isBrandId, isOwnLabel, type BrandId } from "@/lib/brands";
import { db } from "@/lib/db";
import { amazonUrlFor, tidyTitle } from "@/lib/gifts";
import { webAddress } from "@/lib/product-image";

export const PRODUCT_COLUMNS = ["sku", "asin", "title", "listing_name", "color", "size", "price", "stock", "website_url", "image_url", "giftable"] as const;

export type ProductImportReport = {
  error?: string;
  /** One line saying what happened, shown to the person who uploaded. */
  headline?: string;
  added?: number;
  updated?: number;
  /** Rows of the file that were not used. */
  skipped?: number;
  /** Stored products that are no longer live on Amazon and were hidden from creators. */
  hidden?: number;
  notes?: string[];
} | null;

/** Who uploaded and from which file, for the activity log. */
export type ImportSource = { userId: string; fileName: string };

const HEADER_ALIASES: Record<string, string> = {
  article: "title",
  product: "title",
  colour: "color",
  print: "color",
  qty: "stock",
  quantity: "stock",
  inventory: "stock",
  available: "stock",
  afn_fulfillable_quantity: "stock", // Amazon FBA inventory report
  merchant_sku: "sku",
  seller_sku: "sku",
  asin1: "asin", // Amazon All Listings report
  product_name: "listing_name",
  item_name: "listing_name",
  your_price: "price",
  url: "website_url",
};

/** Everything an import may set on a product. Price is text with two decimals, or null. */
type ProductValues = {
  title: string;
  listingName: string | null;
  color: string | null;
  size: string | null;
  asin: string | null;
  amazonUrl: string | null;
  websiteUrl: string | null;
  imageUrl: string | null;
  price: string | null;
  stock: number | null;
  giftable: boolean;
  archived: boolean;
};
type StoredProduct = ProductValues & { id: string; brandId: string; sku: string };

const VALUE_KEYS = [
  "title", "listingName", "color", "size", "asin", "amazonUrl", "websiteUrl", "imageUrl", "price", "stock", "giftable", "archived",
] as const satisfies readonly (keyof ProductValues)[];

function valuesOf(product: ProductValues): ProductValues {
  return Object.fromEntries(VALUE_KEYS.map((key) => [key, product[key]])) as ProductValues;
}

const differs = (a: ProductValues, b: ProductValues) => VALUE_KEYS.some((key) => a[key] !== b[key]);

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Every stored product, keyed by lower-case SKU. */
async function loadProducts(): Promise<Map<string, StoredProduct>> {
  const rows = await db.product.findMany({
    select: {
      id: true, brandId: true, sku: true, title: true, listingName: true, color: true, size: true, asin: true,
      amazonUrl: true, websiteUrl: true, imageUrl: true, price: true, stock: true, giftable: true, archived: true,
    },
  });
  return new Map(rows.map((row) => [row.sku.toLowerCase(), { ...row, price: row.price ? row.price.toFixed(2) : null }]));
}

/**
 * Writes an import in one transaction, with its line in the activity log.
 * Updates go as one statement per thousand products: a round trip for each
 * product would take minutes on a list of this size.
 */
async function writeChanges(
  creates: (ProductValues & { brandId: string; sku: string })[],
  updates: (ProductValues & { id: string })[],
  log: { userId: string; body: string },
) {
  const writes: Prisma.PrismaPromise<unknown>[] = [];
  for (let start = 0; start < creates.length; start += 1000) {
    writes.push(db.product.createMany({ data: creates.slice(start, start + 1000) }));
  }
  for (let start = 0; start < updates.length; start += 1000) {
    const rows = JSON.stringify(updates.slice(start, start + 1000));
    // Dates are stored as UTC without a zone, so now() is converted explicitly.
    writes.push(db.$executeRaw`
      UPDATE "Product" AS p
      SET "title" = v."title", "listingName" = v."listingName", "color" = v."color", "size" = v."size",
          "asin" = v."asin", "amazonUrl" = v."amazonUrl", "websiteUrl" = v."websiteUrl", "imageUrl" = v."imageUrl",
          "price" = v."price", "stock" = v."stock", "giftable" = v."giftable", "archived" = v."archived",
          "updatedAt" = (now() AT TIME ZONE 'UTC')
      FROM jsonb_to_recordset(${rows}::jsonb) AS v(
        "id" text, "title" text, "listingName" text, "color" text, "size" text, "asin" text, "amazonUrl" text,
        "websiteUrl" text, "imageUrl" text, "price" numeric(10, 2), "stock" integer, "giftable" boolean, "archived" boolean)
      WHERE p."id" = v."id"`);
  }
  writes.push(db.activity.create({ data: { userId: log.userId, kind: "csv_import", body: log.body } }));
  await db.$transaction(writes);
}

/* ------------------------------------------------------- CSV and stock files */

/**
 * Adds or updates products from CSV (or Amazon's tab-separated) text. Matched
 * on SKU. Unlike the creator import, this one does overwrite: the file is the
 * source of truth for the catalogue and for stock. Only the columns present in
 * the file are changed, and an empty cell never wipes a stored value.
 */
export async function importProducts(text: string, brandId: BrandId, source: ImportSource): Promise<ProductImportReport> {
  if (!isBrandId(brandId)) return { error: "Choose a brand." };

  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => {
      const key = header.trim().toLowerCase().replace(/[\s-]+/g, "_");
      return HEADER_ALIASES[key] ?? key;
    },
  });
  const headers = parsed.meta.fields ?? [];
  if (!headers.includes("sku")) return { error: `The file needs a "sku" column. Found: ${headers.join(", ") || "none"}.` };
  if (parsed.data.length > 10_000) return { error: "Import at most 10,000 products at a time." };

  const stored = await loadProducts();
  const creates: (ProductValues & { brandId: string; sku: string })[] = [];
  const updates: (ProductValues & { id: string })[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let unchanged = 0;
  let unknown = 0;

  for (const [index, row] of parsed.data.entries()) {
    const line = index + 2;
    const cell = (name: string) => (row[name] ?? "").trim();
    const has = (name: string) => headers.includes(name) && cell(name) !== "";
    const sku = cell("sku");
    if (!sku) {
      skipped += 1;
      continue;
    }
    if (seen.has(sku.toLowerCase())) {
      skipped += 1;
      notes.push(`Row ${line}: SKU ${sku} appears twice; the first row was used.`);
      continue;
    }
    seen.add(sku.toLowerCase());

    // Each value is undefined when the file does not give a usable one, so nothing stored is wiped.
    let stock: number | undefined;
    if (has("stock")) {
      stock = Number(cell("stock").replace(/,/g, ""));
      if (!Number.isInteger(stock) || stock < 0) {
        notes.push(`Row ${line}: stock "${cell("stock")}" is not a whole number; left as it was.`);
        stock = undefined;
      }
    }
    let price: string | undefined;
    if (has("price")) {
      const amount = Number(cell("price").replace(/[$,]/g, ""));
      if (Number.isFinite(amount) && amount >= 0 && amount < 100_000) price = amount.toFixed(2);
      else notes.push(`Row ${line}: price "${cell("price")}" is not a number; left as it was.`);
    }
    let asin: string | undefined;
    if (has("asin")) {
      if (/^[A-Z0-9]{10}$/i.test(cell("asin"))) asin = cell("asin").toUpperCase();
      else notes.push(`Row ${line}: "${cell("asin")}" is not an ASIN; left as it was.`);
    }
    const link = (name: string) => {
      if (!has(name)) return undefined;
      const url = webAddress(cell(name));
      if (!url) notes.push(`Row ${line}: ${name} is not a web address; left as it was.`);
      return url ?? undefined;
    };
    const websiteUrl = link("website_url");
    const imageUrl = link("image_url");
    const giftable = has("giftable") ? !/^(no|false|0|n)$/i.test(cell("giftable")) : undefined;

    const current = stored.get(sku.toLowerCase());
    if (current) {
      if (current.brandId !== brandId) {
        skipped += 1;
        notes.push(`Row ${line}: SKU ${sku} already belongs to another brand; left alone.`);
        continue;
      }
      const next = valuesOf(current);
      if (has("title")) next.title = tidyTitle(cell("title"));
      if (has("listing_name")) next.listingName = cell("listing_name");
      if (has("color")) next.color = cell("color");
      if (has("size")) next.size = cell("size");
      if (asin) Object.assign(next, { asin, amazonUrl: amazonUrlFor(asin) });
      if (websiteUrl) next.websiteUrl = websiteUrl;
      if (imageUrl) next.imageUrl = imageUrl;
      if (price !== undefined) next.price = price;
      if (stock !== undefined) next.stock = stock;
      if (giftable !== undefined) next.giftable = giftable;
      if (differs(current, next)) updates.push({ id: current.id, ...next });
      else unchanged += 1;
    } else if (!has("title")) {
      // Typical of a stock file: it lists SKUs the product list does not have.
      skipped += 1;
      unknown += 1;
    } else {
      creates.push({
        brandId,
        sku,
        title: tidyTitle(cell("title")),
        listingName: cell("listing_name") || null,
        color: cell("color") || null,
        size: cell("size") || null,
        asin: asin ?? null,
        amazonUrl: amazonUrlFor(asin ?? null),
        websiteUrl: websiteUrl ?? null,
        imageUrl: imageUrl ?? null,
        price: price ?? null,
        stock: stock ?? null,
        giftable: giftable ?? true,
        archived: false,
      });
    }
  }
  if (unknown > 0) {
    notes.unshift(
      `${count(unknown, "SKU")} in the file ${unknown === 1 ? "is" : "are"} not in the product list and ${unknown === 1 ? "has" : "have"} no title, so ${unknown === 1 ? "it was" : "they were"} left out. A stock file only updates products that are already listed.`,
    );
  }

  const headline = `${count(creates.length, "product")} added, ${updates.length.toLocaleString("en-US")} updated, ${unchanged.toLocaleString("en-US")} already up to date, ${skipped.toLocaleString("en-US")} left out.`;
  await writeChanges(creates, updates, {
    userId: source.userId,
    body: `Product list for ${brandName(brandId)} updated from "${source.fileName}": ${headline}`,
  });

  return { headline, added: creates.length, updated: updates.length, skipped, notes: notes.slice(0, 50) };
}

/* ---------------------------------------------------- Amazon listing report */

const listingsSchema = z
  .array(
    z.object({
      sku: z.string().min(1).max(150),
      status: z.string().max(40),
      parentage: z.string().max(40),
      productType: z.string().max(80),
      name: z.string().max(600),
      brandName: z.string().max(150),
      asin: z.string().max(10),
      imageUrl: z.string().max(400),
      color: z.string().max(150),
      size: z.string().max(150),
      price: z.string().max(20),
      channel: z.string().max(80),
      condition: z.string().max(40),
    }),
  )
  .min(1)
  .max(20_000);

const LEFT_OUT_WORDS: Record<Exclude<ListingKind, "live">, [string, string]> = {
  family: ["group heading", "group headings"],
  draft: ["bundle or unfinished listing", "bundles or unfinished listings"],
  inactive: ["inactive listing", "inactive listings"],
  removed: ["removed listing", "removed listings"],
  used: ["returned item Amazon resells as used", "returned items Amazon resells as used"],
  not_at_amazon: ["listing not shipped from Amazon's warehouse", "listings not shipped from Amazon's warehouse"],
};

/**
 * Brings the product list of one brand in line with Amazon's Category Listing
 * Report (already read into rows by readListingRows).
 *
 *   - Only listings that are on sale, new and shipped by Amazon become products.
 *   - A new product is offered to creators unless it is sold under another label.
 *     Whether an existing product is offered is the team's choice and is never changed here.
 *   - Stored products that are no longer live on Amazon are hidden, not deleted,
 *     and come back by themselves when a later report shows them live again.
 *   - Stock and website links are not in this report and are left as they are.
 *
 * With checkOnly the report is worked out in full but nothing is written.
 */
export async function importAmazonListings(
  raw: unknown,
  brandId: BrandId,
  source: ImportSource,
  options: { checkOnly?: boolean } = {},
): Promise<ProductImportReport> {
  if (!isBrandId(brandId)) return { error: "Choose a brand." };
  const parsed = listingsSchema.safeParse(raw);
  if (!parsed.success) return { error: "The report could not be read. Upload the Excel file exactly as Amazon produced it." };
  const listings: AmazonListing[] = parsed.data;

  const leftOut = new Map<Exclude<ListingKind, "live">, number>();
  const sellable: AmazonListing[] = [];
  for (const listing of listings) {
    const kind = listingKind(listing);
    if (kind === "live") sellable.push(listing);
    else leftOut.set(kind, (leftOut.get(kind) ?? 0) + 1);
  }
  const ownAsins = new Set(sellable.filter((l) => l.asin && !/^amazon\.found\./i.test(l.sku)).map((l) => l.asin));
  const live = sellable.filter((listing) => !isAmazonCopy(listing, ownAsins));
  const amazonCopies = sellable.length - live.length;
  if (live.length === 0) return { error: "The report has no live listings shipped by Amazon, so nothing was changed." };

  // Refuse the other brand's report: it would hide this brand's whole list.
  const ownCount = (id: BrandId) => live.filter((listing) => isOwnLabel(id, listing)).length;
  const likeliest = BRANDS.map((brand) => ({ brand, listings: ownCount(brand.id) })).sort((a, b) => b.listings - a.listings)[0];
  if (likeliest.brand.id !== brandId && likeliest.listings > ownCount(brandId)) {
    return {
      error: `This looks like the ${likeliest.brand.name} report (${count(likeliest.listings, "listing")} carry that name), but ${brandName(brandId)} is chosen. Nothing was changed.`,
    };
  }
  if (ownCount(brandId) === 0) {
    return { error: `None of the live listings in this report carry the ${brandName(brandId)} name, so nothing was changed.` };
  }

  const stored = await loadProducts();
  // One spelling per colour, counting colours kept from before where the report gives none.
  const colourOf = (listing: AmazonListing) => listing.color || stored.get(listing.sku.toLowerCase())?.color || "";
  const spelling = colourSpellings(live.map(colourOf));
  const creates: (ProductValues & { brandId: string; sku: string })[] = [];
  const updates: (ProductValues & { id: string })[] = [];
  const liveSkus = new Set<string>();
  const otherLabels = new Set<string>();
  let unchanged = 0;
  let restored = 0;
  let repeated = 0;
  let otherBrand = 0;
  let notOffered = 0;
  let nothingToShow = 0;

  for (const listing of live) {
    const key = listing.sku.toLowerCase();
    if (liveSkus.has(key)) {
      repeated += 1;
      continue;
    }
    const current = stored.get(key);
    if (current && current.brandId !== brandId) {
      otherBrand += 1;
      continue;
    }
    liveSkus.add(key);

    const asin = /^[A-Z0-9]{10}$/.test(listing.asin) ? listing.asin : null;
    const imageUrl = /^https:\/\//.test(listing.imageUrl) ? webAddress(listing.imageUrl) : null;
    const price = /^\d+(\.\d+)?$/.test(listing.price) ? Number(listing.price).toFixed(2) : null;
    const own = isOwnLabel(brandId, listing);
    // What the report gives wins; where it is silent, what is stored stays.
    const next: ProductValues = {
      title: categoryFor(listing.productType, listing.name),
      listingName: listing.name || current?.listingName || null,
      color: spelling.get(colourOf(listing).toLowerCase()) ?? null,
      size: listing.size || current?.size || null,
      asin: asin ?? current?.asin ?? null,
      amazonUrl: asin ? amazonUrlFor(asin) : (current?.amazonUrl ?? null),
      websiteUrl: current?.websiteUrl ?? null,
      imageUrl: imageUrl ?? current?.imageUrl ?? null,
      price: price ?? current?.price ?? null,
      stock: current?.stock ?? null,
      giftable: current ? current.giftable : own,
      archived: false,
    };
    if (!own) otherLabels.add(listing.brandName && !isOwnLabel(brandId, { brandName: listing.brandName, name: "" }) ? listing.brandName : listing.name.split(" ")[0]);
    if (!next.giftable) notOffered += 1;
    else if (!next.amazonUrl && !next.imageUrl && !next.websiteUrl) nothingToShow += 1;

    if (!current) creates.push({ brandId, sku: listing.sku, ...next });
    else if (differs(current, next)) {
      updates.push({ id: current.id, ...next });
      if (current.archived) restored += 1;
    } else unchanged += 1;
  }

  // Stored products of this brand that the report no longer shows as live.
  const mine = [...stored.values()].filter((product) => product.brandId === brandId);
  const gone = mine.filter((product) => !product.archived && !liveSkus.has(product.sku.toLowerCase()));
  const notes: string[] = [];
  let hidden = 0;
  if (gone.length > 0 && live.length * 2 < mine.filter((product) => !product.archived).length) {
    notes.push(
      `This report is much smaller than the stored list, so it was treated as a part of the catalogue: ${count(gone.length, "stored product")} missing from it ${gone.length === 1 ? "was" : "were"} left as ${gone.length === 1 ? "it is" : "they are"}.`,
    );
  } else {
    for (const product of gone) updates.push({ id: product.id, ...valuesOf(product), archived: true });
    hidden = gone.length;
  }
  const changed = updates.length - hidden;

  const skippedRows = listings.length - liveSkus.size;
  const parts = (Object.keys(LEFT_OUT_WORDS) as Exclude<ListingKind, "live">[])
    .filter((kind) => leftOut.has(kind))
    .map((kind) => count(leftOut.get(kind) ?? 0, ...LEFT_OUT_WORDS[kind]));
  if (amazonCopies > 0) parts.push(count(amazonCopies, "duplicate Amazon made of a product already listed", "duplicates Amazon made of products already listed"));
  if (repeated > 0) parts.push(count(repeated, "repeated SKU"));
  if (otherBrand > 0) parts.push(count(otherBrand, "SKU that belongs to the other brand", "SKUs that belong to the other brand"));
  if (parts.length > 0) notes.push(`Left out of the product list: ${parts.join(", ")}.`);
  if (notOffered > 0) {
    const labels = [...otherLabels].slice(0, 4).join(", ");
    notes.push(
      `${count(notOffered, "live product")} ${notOffered === 1 ? "is" : "are"} not offered to creators${labels ? ` (this includes other labels: ${labels})` : ""}. Use "Not offered" in the list to review them and switch on any you want.`,
    );
  }
  if (nothingToShow > 0) {
    notes.push(
      `${count(nothingToShow, "live product")} ${nothingToShow === 1 ? "has" : "have"} no Amazon link or photo in the report yet. Creators are not shown ${nothingToShow === 1 ? "it" : "them"} until one is known.`,
    );
  }
  if (hidden > 0) {
    notes.push(`${count(hidden, "stored product")} ${hidden === 1 ? "is" : "are"} no longer live on Amazon and ${hidden === 1 ? "was" : "were"} hidden from creators. Nothing was deleted.`);
  }
  if (restored > 0) notes.push(`${count(restored, "product")} that had been hidden ${restored === 1 ? "is" : "are"} live again and ${restored === 1 ? "was" : "were"} put back.`);
  notes.push("Stock is not in this report. Upload an Amazon inventory file to show the best-stocked products first and hide sold-out ones.");

  const headline = `${count(liveSkus.size, "live product")} in the report: ${creates.length.toLocaleString("en-US")} added, ${changed.toLocaleString("en-US")} updated, ${unchanged.toLocaleString("en-US")} already up to date${hidden > 0 ? `, ${hidden.toLocaleString("en-US")} hidden` : ""}.`;
  if (!options.checkOnly) {
    await writeChanges(creates, updates, {
      userId: source.userId,
      body: `Product list for ${brandName(brandId)} updated from Amazon report "${source.fileName}": ${headline}`,
    });
  }

  return { headline, added: creates.length, updated: changed, skipped: skippedRows, hidden, notes };
}
