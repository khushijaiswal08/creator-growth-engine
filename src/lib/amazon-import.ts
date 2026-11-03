import { Prisma } from "@prisma/client";
import { adGroupKey, codeInAdGroup, creatorCode, readAttributionReport, readBusinessReport, type Grid } from "@/lib/amazon-reports";
import { brandName, type BrandId } from "@/lib/brands";
import { db } from "@/lib/db";
import { DAY_MS, isoDay } from "@/lib/format";

type UnmatchedAdGroup = { adGroup: string; campaign: string; clicks: number; purchases: number };

export type AttributionImportResult =
  | { ok: true; rows: number; matchedRows: number; creators: number; from: string; to: string; unmatched: UnmatchedAdGroup[] }
  | { ok: false; error: string };

/**
 * Imports an Amazon Attribution report for one brand. Each row is matched to
 * a creator link of that brand by its ad group name, exactly as saved (case,
 * spaces and punctuation ignored), or by the creator code at the end of the
 * suggested name ("IG_@emma_k3v9x2"). Nothing is guessed: a name two links
 * share, or a row that matches neither way, is listed back as not matched.
 *
 * A file that mostly matches the other brand's links is refused, since an
 * admin picks the brand by hand. The file replaces what an earlier import said
 * about the same links and days, so uploading a range twice never counts
 * anything twice; a file that would cut an earlier summary in two is refused
 * rather than losing the days it does not cover.
 */
export async function importAttribution(args: { brandId: BrandId; grid: Grid; fileName: string; userId: string; from?: Date | null; to?: Date | null }): Promise<AttributionImportResult> {
  const read = readAttributionReport(args.grid);
  if (!read.ok) return read;
  if (!read.daily && (!args.from || !args.to)) return { ok: false, error: "This report has no dates, so choose the first and last day it covers." };
  if (!read.daily && args.from! > args.to!) return { ok: false, error: "The first day is after the last day." };

  // Every link, both brands, removed ones too: removed links still own their past rows.
  const links = await db.attributionLink.findMany({ select: { id: true, adGroupName: true, archived: true, campaignCreatorId: true, campaignCreator: { select: { campaign: { select: { brandId: true } } } } } });
  const own = links.filter((link) => link.campaignCreator.campaign.brandId === args.brandId);
  const others = links.filter((link) => link.campaignCreator.campaign.brandId !== args.brandId);
  // A key that two links share names nobody (null).
  const index = <K>(list: typeof links, key: (link: (typeof links)[number]) => K) => {
    const map = new Map<K, (typeof links)[number] | null>();
    for (const link of list) {
      const k = key(link);
      map.set(k, map.has(k) && map.get(k)?.id !== link.id ? null : link);
    }
    return map;
  };
  const byName = index(own, (link) => adGroupKey(link.adGroupName));
  // By code only for a creator with exactly one live link, so a second landing page never takes the first one's numbers.
  const byCode = index(own.filter((link) => !link.archived), (link) => creatorCode(link.campaignCreatorId));
  const otherNames = new Set(others.map((link) => adGroupKey(link.adGroupName)));
  const otherCodes = new Set(others.map((link) => creatorCode(link.campaignCreatorId)));
  const linkFor = (adGroup: string) => {
    const key = adGroupKey(adGroup);
    if (byName.has(key)) return byName.get(key) ?? null;
    const code = codeInAdGroup(adGroup);
    return code ? (byCode.get(code) ?? null) : null;
  };

  // Rows that only make sense as the other brand's: refused when they outnumber this brand's.
  const ownHits = read.rows.filter((row) => linkFor(row.adGroup)).length;
  const otherHits = read.rows.filter((row) => !linkFor(row.adGroup) && (otherNames.has(adGroupKey(row.adGroup)) || otherCodes.has(codeInAdGroup(row.adGroup) ?? ""))).length;
  if (otherHits >= 3 && otherHits > ownHits) {
    const other = others[0]?.campaignCreator.campaign.brandId;
    return { ok: false, error: `Most rows in this file belong to ${other ? brandName(other) : "the other brand"}'s creators, not ${brandName(args.brandId)}'s. Check the brand and upload it again.` };
  }

  type Sum = { linkId: string; periodStart: Date; periodEnd: Date; clicks: number; detailPageViews: number; addToCarts: number; purchases: number; unitsSold: number; productSales: number; brandReferralBonus: number | null };
  const sums = new Map<string, Sum>();
  const unmatched = new Map<string, UnmatchedAdGroup>();
  let matchedRows = 0;
  for (const row of read.rows) {
    const link = linkFor(row.adGroup);
    if (!link) {
      const key = `${row.campaign}|${row.adGroup}`;
      const seen = unmatched.get(key) ?? { adGroup: row.adGroup, campaign: row.campaign, clicks: 0, purchases: 0 };
      seen.clicks += row.clicks;
      seen.purchases += row.purchases;
      unmatched.set(key, seen);
      continue;
    }
    matchedRows += 1;
    const start = read.daily ? row.date! : args.from!;
    const end = read.daily ? row.date! : args.to!;
    const key = `${link.id}|${isoDay(start)}|${isoDay(end)}`;
    // One link can appear on several rows for the same day (per publisher or channel): they add up.
    const sum = sums.get(key) ?? { linkId: link.id, periodStart: start, periodEnd: end, clicks: 0, detailPageViews: 0, addToCarts: 0, purchases: 0, unitsSold: 0, productSales: 0, brandReferralBonus: null };
    sum.clicks += row.clicks;
    sum.detailPageViews += row.detailPageViews;
    sum.addToCarts += row.addToCarts;
    sum.purchases += row.purchases;
    sum.unitsSold += row.unitsSold;
    sum.productSales = Math.round((sum.productSales + row.productSales) * 100) / 100;
    if (row.brandReferralBonus !== null) sum.brandReferralBonus = Math.round(((sum.brandReferralBonus ?? 0) + row.brandReferralBonus) * 100) / 100;
    sums.set(key, sum);
  }

  const days = read.daily ? read.rows.map((row) => row.date!.getTime()) : [args.from!.getTime(), args.to!.getTime()];
  const from = new Date(Math.min(...days));
  const to = new Date(Math.max(...days));
  const linkIds = [...new Set([...sums.values()].map((sum) => sum.linkId))];
  const creators = new Set(own.filter((link) => linkIds.includes(link.id)).map((link) => link.campaignCreatorId)).size;
  const unmatchedList = [...unmatched.values()].sort((a, b) => b.clicks - a.clicks);

  // An earlier summary that this file would cut in two: refused, so none of its days are lost.
  const straddling = linkIds.length
    ? await db.attributionStat.findFirst({
        where: { linkId: { in: linkIds }, periodStart: { lte: to }, periodEnd: { gte: from }, OR: [{ periodStart: { lt: from } }, { periodEnd: { gt: to } }] },
        select: { periodStart: true, periodEnd: true },
      })
    : null;
  if (straddling) {
    return {
      ok: false,
      error: `An earlier import holds one total for ${isoDay(straddling.periodStart)} to ${isoDay(straddling.periodEnd)}, and this file (${isoDay(from)} to ${isoDay(to)}) covers only part of it. Upload a daily report for the whole of ${isoDay(straddling.periodStart)} to ${isoDay(straddling.periodEnd)} instead.`,
    };
  }

  await db.$transaction(async (tx) => {
    const created = await tx.reportImport.create({
      data: {
        brandId: args.brandId,
        kind: "attribution",
        fileName: args.fileName.slice(0, 200),
        periodStart: from,
        periodEnd: to,
        rows: read.rows.length,
        matched: matchedRows,
        unmatched: unmatchedList.length > 0 ? (unmatchedList as unknown as Prisma.InputJsonArray) : Prisma.DbNull,
        importedById: args.userId,
      },
    });
    if (linkIds.length > 0) {
      // The newest file wins for the days it covers (everything there lies inside them; see the check above).
      await tx.attributionStat.deleteMany({ where: { linkId: { in: linkIds }, periodStart: { gte: from }, periodEnd: { lte: to } } });
      await tx.attributionStat.createMany({ data: [...sums.values()].map((sum) => ({ ...sum, importId: created.id })) });
    }
    await tx.activity.create({
      data: {
        userId: args.userId,
        kind: "csv_import",
        body: `Imported an Amazon Attribution report for ${brandName(args.brandId)} (${isoDay(from)} to ${isoDay(to)}): ${read.rows.length} rows, ${matchedRows} matched to ${creators} ${creators === 1 ? "creator" : "creators"}${unmatchedList.length ? `, ${unmatchedList.length} ad ${unmatchedList.length === 1 ? "group" : "groups"} not matched` : ""}.`,
      },
    });
  });
  return { ok: true, rows: read.rows.length, matchedRows, creators, from: isoDay(from), to: isoDay(to), unmatched: unmatchedList.slice(0, 50) };
}

export type BusinessImportResult =
  | { ok: true; month: string; products: number; matched: number; units: number; sales: number; unmatched: string[] }
  | { ok: false; error: string };

/** "2026-10" -> 1 October 2026 (UTC); null when not a real month or in the future. */
export function monthFromField(value: string, now = new Date()): Date | null {
  const match = /^(\d{4})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const month = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  if (month.getUTCMonth() !== Number(match[2]) - 1 || month.getTime() > now.getTime()) return null;
  return month;
}

/**
 * Imports one month of the Business Report for one brand. The month comes
 * from the form (the file has none) and uploading the same month again
 * replaces it. Each ASIN is matched to the brand's catalogue, by ASIN then
 * SKU. A file that is mostly the other brand's products is refused, since
 * each brand is its own seller account and a mix-up would be easy to miss.
 */
export async function importBusinessReport(args: { brandId: BrandId; grid: Grid; month: Date; fileName: string; userId: string }): Promise<BusinessImportResult> {
  const read = readBusinessReport(args.grid);
  if (!read.ok) return read;

  const products = await db.product.findMany({ where: { OR: [{ asin: { in: read.rows.map((row) => row.childAsin) } }, { sku: { in: read.rows.flatMap((row) => (row.sku ? [row.sku] : [])) } }] }, select: { id: true, brandId: true, asin: true, sku: true } });
  const own = products.filter((product) => product.brandId === args.brandId);
  const otherBrand = products.filter((product) => product.brandId !== args.brandId);
  const ownAsins = new Map(own.flatMap((product) => (product.asin ? [[product.asin.toUpperCase(), product.id] as const] : [])));
  const ownSkus = new Map(own.map((product) => [product.sku, product.id] as const));
  const otherAsins = new Set(otherBrand.flatMap((product) => (product.asin ? [product.asin.toUpperCase()] : [])));
  const ownHits = read.rows.filter((row) => ownAsins.has(row.childAsin)).length;
  const otherHits = read.rows.filter((row) => otherAsins.has(row.childAsin) && !ownAsins.has(row.childAsin)).length;
  if (otherHits >= 3 && otherHits > ownHits) {
    const other = otherBrand[0]?.brandId;
    return { ok: false, error: `Most products in this file belong to ${other ? brandName(other) : "the other brand"}, not ${brandName(args.brandId)}. Check the brand and upload it again.` };
  }

  const rows = read.rows.map((row) => ({ ...row, productId: ownAsins.get(row.childAsin) ?? (row.sku ? ownSkus.get(row.sku) : undefined) ?? null }));
  const end = new Date(Date.UTC(args.month.getUTCFullYear(), args.month.getUTCMonth() + 1, 1) - DAY_MS);
  const units = rows.reduce((sum, row) => sum + row.unitsOrdered, 0);
  const sales = Math.round(rows.reduce((sum, row) => sum + row.orderedProductSales, 0) * 100) / 100;
  const unmatched = rows.filter((row) => !row.productId).map((row) => row.childAsin);
  const matched = rows.length - unmatched.length;
  const monthLabel = isoDay(args.month).slice(0, 7);

  await db.$transaction(async (tx) => {
    const created = await tx.reportImport.create({
      data: {
        brandId: args.brandId,
        kind: "business",
        fileName: args.fileName.slice(0, 200),
        periodStart: args.month,
        periodEnd: end,
        rows: rows.length,
        matched,
        unmatched: unmatched.length > 0 ? (unmatched as unknown as Prisma.InputJsonArray) : Prisma.DbNull,
        importedById: args.userId,
      },
    });
    // The month is replaced as a whole, so a product missing from the new file does not keep old numbers.
    await tx.productMonthlySales.deleteMany({ where: { brandId: args.brandId, month: args.month } });
    await tx.productMonthlySales.createMany({
      data: rows.map((row) => ({
        brandId: args.brandId,
        month: args.month,
        childAsin: row.childAsin,
        parentAsin: row.parentAsin,
        sku: row.sku,
        title: row.title,
        productId: row.productId,
        unitsOrdered: row.unitsOrdered,
        unitsOrderedB2B: row.unitsOrderedB2B,
        orderedProductSales: row.orderedProductSales,
        totalOrderItems: row.totalOrderItems,
        sessions: row.sessions,
        pageViews: row.pageViews,
        importId: created.id,
      })),
    });
    await tx.activity.create({
      data: { userId: args.userId, kind: "csv_import", body: `Imported the Business Report for ${brandName(args.brandId)}, ${monthLabel}: ${rows.length} products, ${units.toLocaleString("en-US")} units, $${sales.toLocaleString("en-US", { minimumFractionDigits: 2 })} ordered sales.` },
    });
  });
  return { ok: true, month: monthLabel, products: rows.length, matched, units, sales, unmatched: unmatched.slice(0, 50) };
}
