import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { DAY_MS, dayValueInZone } from "@/lib/format";

/**
 * What the imported Amazon files say, added up for the pages that show it.
 *
 * Attribution rows carry Amazon's calendar days as plain dates. A period is
 * given as two instants (the start of its first day and the start of the day
 * after it, on the team's clock), and is turned into those calendar days
 * before comparing: the database compares plain dates, so handing it instants
 * would cut them to the UTC date and shift every period by a day.
 *
 * A summary row (one total over several days) is spread evenly over its days,
 * so a period that holds only part of it gets that part, never all or nothing.
 * Links that were removed keep counting for the days they covered.
 */
type AttributionTotals = { clicks: number; detailPageViews: number; addToCarts: number; purchases: number; unitsSold: number; productSales: number; brandReferralBonus: number | null };

export const EMPTY_TOTALS: AttributionTotals = { clicks: 0, detailPageViews: 0, addToCarts: 0, purchases: 0, unitsSold: 0, productSales: 0, brandReferralBonus: null };

/** Purchases per click, as a percentage with one decimal; null below 10 clicks, where Amazon's own numbers are too thin to read. */
export function conversionRate(totals: Pick<AttributionTotals, "clicks" | "purchases">): number | null {
  return totals.clicks >= 10 ? Math.round((totals.purchases / totals.clicks) * 1000) / 10 : null;
}

/** The calendar day (as a plain date at UTC midnight) that an instant falls on, on the team's clock. */
const zoneDay = (instant: Date) => new Date(`${dayValueInZone(instant)}T00:00:00Z`);

type Range = { from: Date; to: Date };
type StatRow = { periodStart: Date; periodEnd: Date; clicks: number; detailPageViews: number; addToCarts: number; purchases: number; unitsSold: number; productSales: Prisma.Decimal; brandReferralBonus: Prisma.Decimal | null };
const STAT_SELECT = { periodStart: true, periodEnd: true, clicks: true, detailPageViews: true, addToCarts: true, purchases: true, unitsSold: true, productSales: true, brandReferralBonus: true } as const;

/** The share of a row's days that fall in [fromDay, toDay): 1 for a day inside, a fraction for a summary crossing the edge. */
export function shareInside(row: { periodStart: Date; periodEnd: Date }, fromDay: Date, toDay: Date): number {
  const days = Math.round((row.periodEnd.getTime() - row.periodStart.getTime()) / DAY_MS) + 1;
  const first = Math.max(row.periodStart.getTime(), fromDay.getTime());
  const last = Math.min(row.periodEnd.getTime(), toDay.getTime() - DAY_MS);
  const inside = last >= first ? Math.round((last - first) / DAY_MS) + 1 : 0;
  return days > 0 ? Math.min(1, inside / days) : 0;
}

function addRow(totals: AttributionTotals, row: StatRow, share: number): AttributionTotals {
  return {
    clicks: totals.clicks + row.clicks * share,
    detailPageViews: totals.detailPageViews + row.detailPageViews * share,
    addToCarts: totals.addToCarts + row.addToCarts * share,
    purchases: totals.purchases + row.purchases * share,
    unitsSold: totals.unitsSold + row.unitsSold * share,
    productSales: totals.productSales + Number(row.productSales) * share,
    brandReferralBonus: row.brandReferralBonus === null ? totals.brandReferralBonus : (totals.brandReferralBonus ?? 0) + Number(row.brandReferralBonus) * share,
  };
}

/** Whole counts and cents at the end, after any spreading. */
function rounded(totals: AttributionTotals): AttributionTotals {
  const cents = (value: number) => Math.round(value * 100) / 100;
  return {
    clicks: Math.round(totals.clicks),
    detailPageViews: Math.round(totals.detailPageViews),
    addToCarts: Math.round(totals.addToCarts),
    purchases: Math.round(totals.purchases),
    unitsSold: Math.round(totals.unitsSold),
    productSales: cents(totals.productSales),
    brandReferralBonus: totals.brandReferralBonus === null ? null : cents(totals.brandReferralBonus),
  };
}

/** Which stat rows of these creators' links touch the period (all of them without one), and each row's share inside it. */
function statFilter(creators: Prisma.CampaignCreatorWhereInput, range?: Range) {
  const fromDay = range ? zoneDay(range.from) : null;
  const toDay = range ? zoneDay(range.to) : null;
  return {
    where: { link: { campaignCreator: creators }, ...(fromDay && toDay ? { periodStart: { lt: toDay }, periodEnd: { gte: fromDay } } : {}) },
    share: (row: { periodStart: Date; periodEnd: Date }) => (fromDay && toDay ? shareInside(row, fromDay, toDay) : 1),
  };
}

/** The stat rows of these creators' links that touch the period (all of them without one), with each row's share inside it. */
async function rowsFor(creators: Prisma.CampaignCreatorWhereInput, range?: Range) {
  const { where, share } = statFilter(creators, range);
  const rows = await db.attributionStat.findMany({
    where,
    select: { ...STAT_SELECT, link: { select: { campaignCreatorId: true, campaignCreator: { select: { influencerId: true } } } } },
  });
  return rows.map((row) => ({ row, share: share(row) }));
}

function totalOf(rows: { row: StatRow; share: number }[]): AttributionTotals {
  let totals = { ...EMPTY_TOTALS };
  for (const { row, share } of rows) totals = addRow(totals, row, share);
  return rounded(totals);
}

function byInfluencerOf(rows: { row: StatRow & { link: { campaignCreator: { influencerId: string } } }; share: number }[]): Map<string, AttributionTotals> {
  const sums = new Map<string, AttributionTotals>();
  for (const { row, share } of rows) {
    const key = row.link.campaignCreator.influencerId;
    sums.set(key, addRow(sums.get(key) ?? { ...EMPTY_TOTALS }, row, share));
  }
  return new Map([...sums].map(([key, totals]) => [key, rounded(totals)]));
}

/** Everything the links of these creators brought in, optionally within a period. */
export async function attributionTotals(creators: Prisma.CampaignCreatorWhereInput, range?: Range): Promise<AttributionTotals> {
  // The totals never look at which creator a row belongs to, so the rows come without their link: one query instead of three levels.
  const { where, share } = statFilter(creators, range);
  const rows = await db.attributionStat.findMany({ where, select: STAT_SELECT });
  return totalOf(rows.map((row) => ({ row, share: share(row) })));
}

/** The same, per influencer (across their campaigns), for tables of creators. */
export async function attributionByInfluencer(creators: Prisma.CampaignCreatorWhereInput, range?: Range): Promise<Map<string, AttributionTotals>> {
  return byInfluencerOf(await rowsFor(creators, range));
}

/** Both of the above from one fetch of the rows, for a page that shows the totals and the per-creator figures of the same period. */
export async function attributionTotalsAndByInfluencer(creators: Prisma.CampaignCreatorWhereInput, range?: Range): Promise<{ totals: AttributionTotals; byInfluencer: Map<string, AttributionTotals> }> {
  const rows = await rowsFor(creators, range);
  return { totals: totalOf(rows), byInfluencer: byInfluencerOf(rows) };
}

/** The same, per campaign record, so a creator's card can use Amazon's numbers campaign by campaign. */
export async function attributionByCampaignCreator(creators: Prisma.CampaignCreatorWhereInput): Promise<Map<string, AttributionTotals>> {
  const sums = new Map<string, AttributionTotals>();
  for (const { row, share } of await rowsFor(creators)) {
    const key = row.link.campaignCreatorId;
    sums.set(key, addRow(sums.get(key) ?? { ...EMPTY_TOTALS }, row, share));
  }
  return new Map([...sums].map(([key, totals]) => [key, rounded(totals)]));
}

type UnitsTable = {
  months: Date[];
  /** Months that have a Business Report imported; the others show "–" rather than zero. */
  imported: boolean[];
  groups: { title: string; units: number[]; sales: number[]; fromCreators: number[] }[];
  totals: { units: number[]; sales: number[]; fromCreators: number[] };
};

/**
 * Units sold per product group (the catalogue title, e.g. "Tablecloth") for
 * the last few calendar months on the team's clock, from the Business Report,
 * with the units Amazon Attribution counted for creator links pointing at
 * those products beside them.
 */
export async function unitsByMonth(brandIds: string[], monthCount: number, now = new Date()): Promise<UnitsTable> {
  const today = zoneDay(now);
  const months = Array.from({ length: monthCount }, (_, index) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (monthCount - 1 - index), 1)));
  const first = months[0];
  const after = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
  const index = (date: Date) => months.findIndex((month) => month.getUTCFullYear() === date.getUTCFullYear() && month.getUTCMonth() === date.getUTCMonth());

  const [sales, stats, products] = await Promise.all([
    db.productMonthlySales.findMany({ where: { brandId: { in: brandIds }, month: { gte: first, lt: after } }, select: { month: true, unitsOrdered: true, orderedProductSales: true, product: { select: { title: true } } } }),
    db.attributionStat.findMany({
      where: { periodStart: { lt: after }, periodEnd: { gte: first }, link: { asin: { not: null }, campaignCreator: { campaign: { brandId: { in: brandIds } } } } },
      select: { periodStart: true, periodEnd: true, unitsSold: true, link: { select: { asin: true } } },
    }),
    // Every catalogue title with an ASIN, loaded alongside rather than after the links are known.
    db.product.findMany({ where: { brandId: { in: brandIds }, asin: { not: null } }, select: { asin: true, title: true } }),
  ]);
  // Only the products whose ASIN a link names exactly (the match is case-sensitive, as the database's would be).
  const linkAsins = new Set(stats.map((row) => row.link.asin!));
  const asinTitles = new Map(products.filter((product) => linkAsins.has(product.asin!)).map((product) => [product.asin!.toUpperCase(), product.title]));

  const groups = new Map<string, { title: string; units: number[]; sales: number[]; fromCreators: number[] }>();
  const group = (title: string) => {
    let found = groups.get(title);
    if (!found) groups.set(title, (found = { title, units: months.map(() => 0), sales: months.map(() => 0), fromCreators: months.map(() => 0) }));
    return found;
  };
  const imported = months.map(() => false);
  for (const row of sales) {
    const at = index(row.month);
    if (at < 0) continue;
    imported[at] = true;
    const target = group(row.product?.title ?? "Not in the catalogue");
    target.units[at] += row.unitsOrdered;
    target.sales[at] = Math.round((target.sales[at] + Number(row.orderedProductSales)) * 100) / 100;
  }
  for (const row of stats) {
    const target = group(asinTitles.get(row.link.asin!.toUpperCase()) ?? "Not in the catalogue");
    months.forEach((month, at) => {
      const next = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
      target.fromCreators[at] += row.unitsSold * shareInside(row, month, next);
    });
  }
  const list = [...groups.values()]
    .map((row) => ({ ...row, fromCreators: row.fromCreators.map((value) => Math.round(value)) }))
    .sort((a, b) => b.units.reduce((s, v) => s + v, 0) - a.units.reduce((s, v) => s + v, 0));
  const column = (pick: (row: (typeof list)[number]) => number[]) => months.map((_, at) => Math.round(list.reduce((sum, row) => sum + pick(row)[at], 0) * 100) / 100);
  return { months, imported, groups: list, totals: { units: column((row) => row.units), sales: column((row) => row.sales), fromCreators: column((row) => row.fromCreators) } };
}
