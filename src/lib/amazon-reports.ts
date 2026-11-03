import type { Platform } from "@prisma/client";
import { ASIN_RE } from "@/lib/amazon-listing";

/**
 * Readers for the Amazon files the team uploads, as plain functions over a
 * grid of cells (the browser turns the CSV or Excel file into rows first).
 *
 * Amazon does not publish the exact column headers of either file and they
 * change now and then, so columns are found by name, never by position, and
 * each column accepts the spellings seen in the wild. Only what the portal
 * needs is required; everything else is optional.
 */
export type Grid = string[][];

/** Larger files are refused rather than half-read. */
export const MAX_REPORT_ROWS = 20_000;

/** "(Child) ASIN" -> "child asin", "Sessions – Total" -> "sessions total", "Click-throughs" -> "click throughs". */
export function headerKey(value: unknown): string {
  return String(value ?? "")
    .replace(/^﻿/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const EMPTY = new Set(["", "-", "--", "n/a", "na", "null"]);

/** "1,017" -> 1017; "" or "--" -> null. Never negative, never fractional. */
export function parseCount(value: unknown): number | null {
  const text = String(value ?? "").trim().toLowerCase();
  if (EMPTY.has(text)) return null;
  const number = Number(text.replace(/[,\s]/g, ""));
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

/** "$1,017.50", "US$ 12", "Can$3.10", "12.5" -> dollars with two decimals; "" or "--" -> null. */
export function parseMoney(value: unknown): number | null {
  const text = String(value ?? "").trim().toLowerCase();
  if (EMPTY.has(text)) return null;
  const cleaned = text.replace(/^[a-z]*\$/, "").replace(/[$,\s]/g, "");
  const number = Number(cleaned);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * A calendar day as Amazon prints it ("2026-10-28", "10/28/2026", "10/28/26",
 * "Oct 28, 2026", "20261028"), as midnight UTC. Amazon's days are its own
 * calendar days, so they are never shifted into another time zone.
 */
export function parseDay(value: unknown): Date | null {
  const text = String(value ?? "").trim();
  let year: number, month: number, day: number;
  let match: RegExpExecArray | null;
  if ((match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text))) [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{4})(\d{2})(\d{2})$/.exec(text))) [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text))) [month, day, year] = [Number(match[1]), Number(match[2]), Number(match[3].length === 2 ? `20${match[3]}` : match[3])];
  else if ((match = /^([a-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/i.exec(text)) && MONTHS.includes(match[1].toLowerCase())) [month, day, year] = [MONTHS.indexOf(match[1].toLowerCase()) + 1, Number(match[2]), Number(match[3])];
  else return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null;
}

type Columns = Record<string, readonly string[]>;

/**
 * The header row (the first of the top 15 rows that names the required
 * columns, so title lines above the table are skipped) and where each known
 * column sits in it. Each column's spellings are tried in order, so the plain
 * "Purchases" wins over a "Total purchases" column (which can include brand
 * halo sales) wherever both appear.
 */
function locate<C extends Columns>(grid: Grid, columns: C, required: readonly (keyof C & string)[]): { header: number; at: Partial<Record<keyof C & string, number>> } | null {
  type K = keyof C & string;
  for (let row = 0; row < Math.min(grid.length, 15); row += 1) {
    const keys = grid[row].map(headerKey);
    const at: Partial<Record<K, number>> = {};
    for (const name of Object.keys(columns) as K[]) {
      for (const alias of columns[name]) {
        const index = keys.indexOf(alias);
        if (index >= 0) {
          at[name] = index;
          break;
        }
      }
    }
    if (required.every((name) => at[name] !== undefined)) return { header: row, at };
  }
  return null;
}

// --- Amazon Attribution ----------------------------------------------------------------------------

const ATTRIBUTION_COLUMNS = {
  campaign: ["campaign", "campaigns", "campaign name", "order", "order name"],
  adGroup: ["ad group", "ad group name", "adgroup", "adgroup name", "line item", "line item name"],
  publisher: ["publisher", "publisher name"],
  channel: ["channel"],
  date: ["date", "day", "report date"],
  clicks: ["clicks", "click throughs", "clickthroughs", "total clicks", "total click throughs"],
  detailPageViews: ["detail page views", "detail page view", "dpv", "total dpv", "total detail page views"],
  addToCarts: ["add to carts", "add to cart", "atc", "total atc", "total add to carts"],
  purchases: ["purchases", "purchase", "total purchases"],
  unitsSold: ["units sold", "total units sold"],
  productSales: ["product sales", "total product sales", "sales", "total sales"],
  brandReferralBonus: ["brand referral bonus", "estimated brand referral bonus", "brb", "brb bonus amount"],
} as const;

/** Without an ad group column there is nothing to match rows to. */
const ATTRIBUTION_REQUIRED = ["adGroup"] as const;

type AttributionRow = {
  campaign: string;
  adGroup: string;
  publisher: string;
  date: Date | null;
  clicks: number;
  detailPageViews: number;
  addToCarts: number;
  purchases: number;
  unitsSold: number;
  productSales: number;
  brandReferralBonus: number | null;
};

/**
 * Rows of an Amazon Attribution campaign report (daily or summary). Needs an
 * ad group column and at least one of clicks, purchases or product sales;
 * rows without an ad group (totals, blank lines) are skipped.
 */
export function readAttributionReport(grid: Grid): { ok: true; rows: AttributionRow[]; daily: boolean } | { ok: false; error: string } {
  if (grid.length > MAX_REPORT_ROWS) return { ok: false, error: `The file has more than ${MAX_REPORT_ROWS.toLocaleString("en-US")} rows. Download a shorter date range.` };
  const found = locate(grid, ATTRIBUTION_COLUMNS, ATTRIBUTION_REQUIRED);
  if (!found) return { ok: false, error: "This does not look like an Amazon Attribution report: there is no Ad group column. Download the Campaign report (daily) from Amazon Attribution and upload it unchanged." };
  const { header, at } = found;
  if (at.clicks === undefined && at.purchases === undefined && at.productSales === undefined) {
    return { ok: false, error: "The report has no Clicks, Purchases or Product sales column, so there is nothing to count." };
  }
  const cell = (row: string[], name: keyof typeof ATTRIBUTION_COLUMNS) => (at[name] === undefined ? "" : String(row[at[name]!] ?? "").trim());
  const rows: AttributionRow[] = [];
  for (const row of grid.slice(header + 1)) {
    const adGroup = cell(row, "adGroup");
    if (!adGroup || /^total/i.test(adGroup)) continue;
    rows.push({
      campaign: cell(row, "campaign"),
      adGroup,
      publisher: cell(row, "publisher"),
      date: at.date === undefined ? null : parseDay(cell(row, "date")),
      clicks: parseCount(cell(row, "clicks")) ?? 0,
      detailPageViews: parseCount(cell(row, "detailPageViews")) ?? 0,
      addToCarts: parseCount(cell(row, "addToCarts")) ?? 0,
      purchases: parseCount(cell(row, "purchases")) ?? 0,
      unitsSold: parseCount(cell(row, "unitsSold")) ?? 0,
      productSales: parseMoney(cell(row, "productSales")) ?? 0,
      brandReferralBonus: at.brandReferralBonus === undefined ? null : parseMoney(cell(row, "brandReferralBonus")),
    });
  }
  if (rows.length === 0) return { ok: false, error: "The report has no ad group rows." };
  const daily = at.date !== undefined && rows.every((row) => row.date !== null);
  if (at.date !== undefined && !daily) return { ok: false, error: "Some rows have a date Amazon's format does not match. Upload the file exactly as Amazon produced it." };
  return { ok: true, rows, daily };
}

// --- Seller Central Business Report ------------------------------------------------------------------

const BUSINESS_COLUMNS = {
  childAsin: ["child asin", "asin"],
  parentAsin: ["parent asin"],
  title: ["title"],
  sku: ["sku"],
  unitsOrdered: ["units ordered"],
  unitsOrderedB2B: ["units ordered b2b"],
  orderedProductSales: ["ordered product sales"],
  totalOrderItems: ["total order items"],
  sessions: ["sessions total", "sessions"],
  pageViews: ["page views total", "page views"],
} as const;

/** The two columns the Business Report cannot be read without. */
const BUSINESS_REQUIRED = ["childAsin", "unitsOrdered"] as const;

type BusinessRow = {
  childAsin: string;
  parentAsin: string | null;
  title: string | null;
  sku: string | null;
  unitsOrdered: number;
  unitsOrderedB2B: number | null;
  orderedProductSales: number;
  totalOrderItems: number | null;
  sessions: number | null;
  pageViews: number | null;
};

/**
 * Rows of "Detail Page Sales and Traffic by Child Item". Needs the child ASIN
 * and Units Ordered; the file has no dates, so the month comes from the person
 * uploading it. One ASIN on several rows (one per SKU) is added up.
 */
export function readBusinessReport(grid: Grid): { ok: true; rows: BusinessRow[] } | { ok: false; error: string } {
  if (grid.length > MAX_REPORT_ROWS) return { ok: false, error: `The file has more than ${MAX_REPORT_ROWS.toLocaleString("en-US")} rows.` };
  const found = locate(grid, BUSINESS_COLUMNS, BUSINESS_REQUIRED);
  if (!found) {
    return { ok: false, error: "This does not look like a Business Report: it needs (Child) ASIN and Units Ordered columns. In Seller Central open Reports > Business Reports > Detail Page Sales and Traffic by Child Item, pick one month and download the CSV." };
  }
  const { header, at } = found;
  const cell = (row: string[], name: keyof typeof BUSINESS_COLUMNS) => (at[name] === undefined ? "" : String(row[at[name]!] ?? "").trim());
  const byAsin = new Map<string, BusinessRow>();
  for (const row of grid.slice(header + 1)) {
    const childAsin = cell(row, "childAsin").toUpperCase();
    if (!ASIN_RE.test(childAsin)) continue;
    const units = parseCount(cell(row, "unitsOrdered")) ?? 0;
    const known = byAsin.get(childAsin);
    if (known) {
      // Several SKUs of one ASIN: units, sales and order items add up; traffic is the ASIN's and repeats on each row.
      const addCount = (was: number | null, more: number | null) => (was === null && more === null ? null : (was ?? 0) + (more ?? 0));
      known.unitsOrdered += units;
      known.unitsOrderedB2B = addCount(known.unitsOrderedB2B, parseCount(cell(row, "unitsOrderedB2B")));
      known.totalOrderItems = addCount(known.totalOrderItems, parseCount(cell(row, "totalOrderItems")));
      known.orderedProductSales = Math.round((known.orderedProductSales + (parseMoney(cell(row, "orderedProductSales")) ?? 0)) * 100) / 100;
      continue;
    }
    byAsin.set(childAsin, {
      childAsin,
      parentAsin: cell(row, "parentAsin").toUpperCase() || null,
      title: cell(row, "title").slice(0, 300) || null,
      sku: cell(row, "sku").slice(0, 100) || null,
      unitsOrdered: units,
      unitsOrderedB2B: parseCount(cell(row, "unitsOrderedB2B")),
      orderedProductSales: parseMoney(cell(row, "orderedProductSales")) ?? 0,
      totalOrderItems: parseCount(cell(row, "totalOrderItems")),
      sessions: parseCount(cell(row, "sessions")),
      pageViews: parseCount(cell(row, "pageViews")),
    });
  }
  if (byAsin.size === 0) return { ok: false, error: "The file has no product rows with an ASIN." };
  return { ok: true, rows: [...byAsin.values()] };
}

// --- Sending a file ----------------------------------------------------------------------------------

/**
 * The file cut down to what the readers use: the rows from the header on, and
 * only the known columns, so a large export fits in one upload. Run in the
 * browser before sending; the server reads the result exactly as it would
 * read the whole file. A file the readers do not recognise is sent unchanged
 * (up to the row limit) so the server can say what is wrong with it.
 */
export function compactGrid(grid: Grid, kind: "attribution" | "business"): Grid {
  const found = kind === "attribution" ? locate(grid, ATTRIBUTION_COLUMNS, ATTRIBUTION_REQUIRED) : locate(grid, BUSINESS_COLUMNS, BUSINESS_REQUIRED);
  if (!found) return grid.slice(0, MAX_REPORT_ROWS + 1).map((row) => row.slice(0, 40));
  const keep = Object.values(found.at).filter((index): index is number => index !== undefined);
  return grid.slice(found.header, found.header + MAX_REPORT_ROWS + 1).map((row) => keep.map((index) => String(row[index] ?? "")));
}

// --- Attribution links -------------------------------------------------------------------------------

type ParsedAttributionLink = { url: string; maas: string; asin: string | null; store: boolean };

/**
 * Checks a pasted Amazon Attribution tag. It must be an amazon.com address
 * carrying the tag (maas=..., with ref_=aa_maas or tag=maas). Search-result
 * pages do not track, and link shorteners drop the tag, so both are refused.
 */
export function parseAttributionUrl(input: string): { ok: true; link: ParsedAttributionLink } | { ok: false; error: string } {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, error: "Paste the full Amazon link, starting with https://" };
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "Paste the full Amazon link, starting with https://" };
  if (host !== "amazon.com" && host !== "www.amazon.com") {
    return { ok: false, error: /amzn\.|a\.co$/.test(host) ? "Short links drop the tracking tag. Paste the full amazon.com link from Amazon Attribution." : "This is not an amazon.com link." };
  }
  const maas = url.searchParams.get("maas")?.trim() ?? "";
  if (!maas || (url.searchParams.get("ref_") !== "aa_maas" && url.searchParams.get("tag") !== "maas")) {
    return { ok: false, error: "This link has no Amazon Attribution tag (maas=...). Copy the tag from Amazon Attribution, not the product address." };
  }
  if (/^\/s(\/|$)/.test(url.pathname)) return { ok: false, error: "Search-result links are not tracked by Amazon. Point the tag at a product page or your Store." };
  const asin = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i.exec(url.pathname)?.[1]?.toUpperCase() ?? null;
  const store = url.pathname.includes("/stores/");
  return { ok: true, link: { url: url.toString().slice(0, 2000), maas: maas.slice(0, 200), asin, store } };
}

const PLATFORM_CODES: Record<Platform, string> = { instagram: "IG", tiktok: "TT", youtube: "YT" };

/** The code at the end of a suggested ad group name: the last six characters of the creator's campaign record. */
export const creatorCode = (campaignCreatorId: string) => campaignCreatorId.slice(-6).toLowerCase();

/** The ad group name to type in Amazon Attribution, e.g. "IG_@emmaslinen_k3v9x2": the end ties report rows back to this creator. */
export function suggestedAdGroupName(platform: Platform | null, handle: string | null, campaignCreatorId: string): string {
  const who = handle ? `@${handle.replace(/^@/, "")}` : "creator";
  return `${platform ? PLATFORM_CODES[platform] : "WEB"}_${who}_${creatorCode(campaignCreatorId)}`;
}

/** The creator code at the end of an ad group name ("IG_@emma_k3v9x2" -> "k3v9x2"), or null when it does not end in one. */
export function codeInAdGroup(name: string): string | null {
  return /[_\s-]([a-z0-9]{6})\s*$/i.exec(name)?.[1]?.toLowerCase() ?? null;
}

/** Ad group names compared without case, spaces or punctuation, so "IG_@Emma_k3v9x2" matches "ig @emma k3v9x2". */
export const adGroupKey = (name: string) => headerKey(name);
