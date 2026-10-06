/**
 * Reading Amazon's "Category Listing Report": the Excel file Seller Central
 * produces with every listing in the account and its attributes.
 *
 * Nothing here touches the database or the server, so the same code runs in
 * the browser (where the Excel file is opened), in scripts and in tests.
 */

/** The sheet of the workbook that holds the listings. */
export const LISTING_SHEET = "Template";

/** One row of the report, cut down to what the portal uses. Every value is text; "" means not given. */
export type AmazonListing = {
  sku: string;
  /** Active, Inactive, Removed, or something else for drafts and bundles. */
  status: string;
  /** Parent (a group heading), Child or "". */
  parentage: string;
  /** Amazon's own product type, e.g. TABLECLOTH. */
  productType: string;
  /** The listing's full name. */
  name: string;
  brandName: string;
  asin: string;
  imageUrl: string;
  color: string;
  size: string;
  price: string;
  /** Fulfilment channel, e.g. "Fulfillment by Amazon (NA)". */
  channel: string;
  /** New, "Used - Like New", ... */
  condition: string;
};

export const LISTING_FIELDS = [
  "sku", "status", "parentage", "productType", "name", "brandName", "asin", "imageUrl", "color", "size", "price", "channel", "condition",
] as const satisfies readonly (keyof AmazonListing)[];

/**
 * Where each value sits, by Amazon's own field name (the row under the column
 * titles). Positions differ between accounts, so nothing is read by position.
 * Where two columns are listed, the second is used when the first is empty.
 */
const COLUMNS = {
  sku: [/^contribution_sku#1\.value$/],
  status: [/^::listing_status$/],
  parentage: [/^parentage_level\[[^#]*\]#1\.value$/],
  productType: [/^product_type#1\.value$/],
  name: [/^::title$/, /^item_name\[[^#]*\]#1\.value$/],
  brandName: [/^brand\[[^#]*\]#1\.value$/],
  idType: [/\.product_id_type$/],
  idValue: [/\.product_id_value$/],
  imageUrl: [/^main_product_image_locator\[[^#]*\]#1\.media_location$/],
  color: [/^color\[[^#]*\]#1\.value$/],
  // Clothing keeps its size in a separate column.
  size: [/^size\[[^#]*\]#1\.value$/, /^apparel_size\[[^#]*\]#1\.size$/],
  price: [/^purchasable_offer\[marketplace_id=ATVPDKIKX0DER\]\[audience=ALL\]#1\.our_price#1\.schedule#1\.value_with_tax$/],
  channel: [/^fulfillment_availability#1\.fulfillment_channel_code$/],
  condition: [/^condition_type\[[^#]*\]#1\.value$/],
} as const;

const MAX_LISTINGS = 20_000;

const text = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();

/**
 * Turns the rows of the report's "Template" sheet into listings.
 * `rows` is the sheet as a grid of cells, top row first.
 */
export function readListingRows(rows: unknown[][]): { listings: AmazonListing[] } | { error: string } {
  const notTheReport =
    "This does not look like Amazon's Category Listing Report. Download it from Seller Central (Inventory, Inventory Reports) and upload the file unchanged.";

  const headerAt = rows.slice(0, 25).findIndex((row) => row.some((cell) => COLUMNS.sku[0].test(text(cell))));
  if (headerAt < 0) return { error: notTheReport };
  const fields = rows[headerAt].map(text);

  const at = Object.fromEntries(
    Object.entries(COLUMNS).map(([key, patterns]) => [
      key,
      patterns.map((pattern) => fields.findIndex((field) => pattern.test(field))).filter((index) => index >= 0),
    ]),
  ) as Record<keyof typeof COLUMNS, number[]>;
  if (at.status.length === 0 || at.productType.length === 0 || at.name.length === 0) return { error: notTheReport };

  const pick = (row: unknown[], key: keyof typeof COLUMNS) => {
    for (const index of at[key]) {
      const value = text(row[index]);
      if (value) return value;
    }
    return "";
  };

  const listings: AmazonListing[] = [];
  for (const [offset, row] of rows.slice(headerAt + 1).entries()) {
    const sku = pick(row, "sku");
    if (!sku) continue;
    // Amazon puts one made-up example row straight under the headings.
    if (offset === 0 && sku === "ABC123") continue;

    const idValue = pick(row, "idValue").toUpperCase();
    const imageUrl = pick(row, "imageUrl");
    const price = pick(row, "price").replace(/,/g, "");
    listings.push({
      sku,
      status: pick(row, "status"),
      parentage: pick(row, "parentage"),
      productType: pick(row, "productType"),
      name: pick(row, "name"),
      brandName: pick(row, "brandName"),
      asin: pick(row, "idType").toUpperCase() === "ASIN" && /^[A-Z0-9]{10}$/.test(idValue) ? idValue : "",
      imageUrl: /^https:\/\/\S+$/.test(imageUrl) ? imageUrl : "",
      color: pick(row, "color"),
      size: pick(row, "size"),
      price: /^\d+(\.\d+)?$/.test(price) ? price : "",
      channel: pick(row, "channel"),
      condition: pick(row, "condition"),
    });
  }

  if (listings.length === 0) return { error: "The report has no listings in it." };
  if (listings.length > MAX_LISTINGS) return { error: `The report has more than ${MAX_LISTINGS.toLocaleString("en-US")} listings.` };
  return { listings };
}

/**
 * What a row of the report is, as far as gifting goes:
 *   live              on sale, new, and shipped by Amazon: can be sent as a gift
 *   family            a group heading for a set of colours and sizes, not something that ships
 *   inactive, removed the listing exists but is not on sale
 *   draft             bundles and unfinished listings (Amazon gives them no proper status)
 *   used              Amazon's resale of returned items
 *   not_at_amazon     on sale, but not set up to ship from Amazon's warehouse
 */
export type ListingKind = "live" | "family" | "inactive" | "removed" | "draft" | "used" | "not_at_amazon";

export function listingKind(listing: AmazonListing): ListingKind {
  if (listing.parentage.toLowerCase() === "parent") return "family";
  const status = listing.status.toLowerCase();
  if (status === "inactive") return "inactive";
  if (status === "removed") return "removed";
  if (status !== "active") return "draft";
  if (/^amzn\.gr\./i.test(listing.sku) || (listing.condition !== "" && !/^new$/i.test(listing.condition))) return "used";
  if (!/amazon/i.test(listing.channel)) return "not_at_amazon";
  return "live";
}

/**
 * When Amazon finds stray units in its warehouse it makes its own SKU
 * ("Amazon.Found.B0...") for a product that already has one. Those copies are
 * left out so each product appears once.
 */
export function isAmazonCopy(listing: AmazonListing, asinsOfOwnSkus: Set<string>): boolean {
  return /^amazon\.found\./i.test(listing.sku) && listing.asin !== "" && asinsOfOwnSkus.has(listing.asin);
}

/* ------------------------------------------------------------ product names */

/** Amazon's product types, in the words a creator would use. */
const CATEGORY_NAMES: Record<string, string> = {
  APRON: "Apron",
  BLANK_BOOK: "Journal",
  CADDY: "Desk Organizer",
  CLOTH_NAPKIN: "Napkins",
  COSMETIC_CASE: "Cosmetic Bag",
  CURTAIN: "Curtain",
  DECORATIVE_PILLOW_COVER: "Pillow Cover",
  DRESS: "Dress",
  DRINK_COASTER: "Coasters",
  FACIAL_TISSUE_HOLDER: "Tissue Box Cover",
  LAMPSHADE: "Lamp Shade",
  PICTURE_FRAME: "Picture Frame",
  PILLOWCASE: "Pillow Cover",
  PLACEMAT: "Placemats",
  RUG: "Rug",
  SELF_STICK_NOTE: "Sticky Note Holder",
  TABLECLOTH: "Tablecloth",
  TABLE_RUNNER: "Table Runner",
  TOTE_BAG: "Tote Bag",
  TREE_SKIRT: "Christmas Tree Skirt",
};

/** Types Amazon uses for several different things: the listing's own name decides. */
const CATEGORY_BY_WORDING: Record<string, { pattern: RegExp; name: string }[]> = {
  BLANKET: [{ pattern: /quilt/i, name: "Quilt" }],
  BEDDING_SET: [{ pattern: /quilt/i, name: "Quilt" }],
  HOME: [{ pattern: /stocking/i, name: "Christmas Stocking" }],
  PILLOW: [
    { pattern: /insert/i, name: "Pillow Insert" },
    { pattern: /chair|seat/i, name: "Chair Cushion" },
    { pattern: /sham|cover/i, name: "Pillow Cover" },
  ],
  SPORTING_GOODS: [{ pattern: /bottle/i, name: "Water Bottle Holder" }],
  TOWEL: [
    { pattern: /bath/i, name: "Bath Towel" },
    { pattern: /dish ?cloth|wash ?cloth/i, name: "Dish Cloth" },
    { pattern: /kitchen|tea towel/i, name: "Kitchen Towel" },
  ],
};

/** "BATHTUB_SHOWER_MAT" -> "Bathtub Shower Mat". */
function titleCase(raw: string): string {
  return raw
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/** The short product name creators choose from first, e.g. "Tablecloth". */
export function categoryFor(productType: string, listingName: string): string {
  const type = productType.trim().toUpperCase();
  const byWording = CATEGORY_BY_WORDING[type]?.find((rule) => rule.pattern.test(listingName));
  return byWording?.name ?? CATEGORY_NAMES[type] ?? (titleCase(type) || "Other");
}

/**
 * Amazon lists some colours twice with different capitals ("Queen Blue" and
 * "queen blue"). Returns one spelling for each: the most used, then the first seen.
 */
export function colourSpellings(colours: string[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const colour of colours) {
    if (!colour) continue;
    const spellings = counts.get(colour.toLowerCase()) ?? new Map<string, number>();
    spellings.set(colour, (spellings.get(colour) ?? 0) + 1);
    counts.set(colour.toLowerCase(), spellings);
  }
  return new Map([...counts].map(([key, spellings]) => [key, [...spellings].sort((a, b) => b[1] - a[1])[0][0]]));
}
