import type { Metadata } from "next";
import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { AttributionUpload, BusinessUpload } from "@/components/amazon-upload";
import { CreatorName } from "@/components/creator-card";
import { EmptyRow, PageHeader } from "@/components/panel";
import { ReportTabs } from "@/components/report-tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { attributionByInfluencer, conversionRate, EMPTY_TOTALS, unitsByMonth } from "@/lib/amazon-stats";
import { viewed } from "@/lib/brand-scope";
import { BRANDS, brandName, brandsLabel } from "@/lib/brands";
import { db } from "@/lib/db";
import { DAY_MS, formatDateTime, formatDollars, isoDay } from "@/lib/format";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Amazon sales" };

const PERIODS = [
  { key: "30", label: "Last 30 days", days: 30 },
  { key: "90", label: "Last 90 days", days: 90 },
  { key: "all", label: "All time", days: null },
] as const;
const MONTHS_SHOWN = 6;
const IMPORTS_SHOWN = 6;

const monthLabel = (date: Date) => date.toLocaleString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });

/**
 * What Amazon says the creators brought in, from the two files the team
 * uploads: the Attribution report (clicks, orders and sales per creator link)
 * and the monthly Business Report (units sold per product). Both are per
 * brand, since each brand is its own seller account.
 */
export default async function AmazonReportPage({ searchParams }: { searchParams: Promise<{ period?: string }> }) {
  const user = await requireUser();
  const view = viewed(user);
  const params = await searchParams;
  const period = PERIODS.find((option) => option.key === params.period) ?? PERIODS[0];
  const now = new Date();
  // The last N days up to and including today, on the team's clock.
  const range = period.days ? { from: new Date(now.getTime() - (period.days - 1) * DAY_MS), to: new Date(now.getTime() + DAY_MS) } : undefined;
  const brandIds = view.brandId ? [view.brandId] : BRANDS.map((brand) => brand.id);
  // Someone with one brand imports for it; someone with both picks.
  const uploadBrands = (user.brandId ? BRANDS.filter((brand) => brand.id === user.brandId) : BRANDS).map((brand) => ({ id: brand.id, name: brand.name }));

  const [totals, links, units, imports] = await Promise.all([
    attributionByInfluencer(view.creators, range),
    // Live links, and removed ones that still have numbers.
    db.attributionLink.findMany({
      where: { campaignCreator: view.creators, OR: [{ archived: false }, { stats: { some: {} } }] },
      select: { campaignCreator: { select: { campaign: { select: { name: true } }, influencer: { select: { id: true, name: true } } } } },
    }),
    unitsByMonth(brandIds, MONTHS_SHOWN, now),
    db.reportImport.findMany({ where: { brandId: { in: brandIds } }, orderBy: { createdAt: "desc" }, take: IMPORTS_SHOWN, select: { id: true, brandId: true, kind: true, fileName: true, periodStart: true, periodEnd: true, rows: true, matched: true, createdAt: true, importedBy: { select: { name: true } } } }),
  ]);

  // Every creator with a link, with what their links brought in during the period, best first.
  const byCreator = new Map<string, { id: string; name: string; links: number; campaigns: Set<string> }>();
  for (const link of links) {
    const { influencer, campaign } = link.campaignCreator;
    const row = byCreator.get(influencer.id) ?? { id: influencer.id, name: influencer.name, links: 0, campaigns: new Set<string>() };
    row.links += 1;
    row.campaigns.add(campaign.name);
    byCreator.set(influencer.id, row);
  }
  const creators = [...byCreator.values()]
    .map((row) => ({ ...row, totals: totals.get(row.id) ?? EMPTY_TOTALS }))
    .sort((a, b) => b.totals.productSales - a.totals.productSales || b.totals.clicks - a.totals.clicks || a.name.localeCompare(b.name));
  const sum = creators.reduce((all, row) => ({ clicks: all.clicks + row.totals.clicks, purchases: all.purchases + row.totals.purchases, sales: all.sales + row.totals.productSales }), { clicks: 0, purchases: 0, sales: 0 });

  return (
    <>
      <PageHeader title="Amazon sales" meta={`${brandsLabel(view.brandId, "Both brands")} ·${creators.length} ${creators.length === 1 ? "creator" : "creators"} with a tracking link`} />
      <ReportTabs current="amazon" />

      <div className="mb-6 grid gap-5 lg:grid-cols-2">
        <section className="card p-5" aria-labelledby="aa-title">
          <h2 id="aa-title">Attribution report</h2>
          <p className="mt-1 mb-4 text-sm text-muted-foreground">Amazon Ads › Amazon Attribution › Reports › Campaign report, daily. Rows find each creator by the ad group name on their tracking link.</p>
          <AttributionUpload brands={uploadBrands} />
        </section>
        <section className="card p-5" aria-labelledby="br-title">
          <h2 id="br-title">Business Report</h2>
          <p className="mt-1 mb-4 text-sm text-muted-foreground">Seller Central › Reports › Business Reports › Detail Page Sales and Traffic by Child Item, one month at a time. Uploading a month again replaces it.</p>
          <BusinessUpload brands={uploadBrands} />
        </section>
      </div>

      <section className="card mb-6 overflow-hidden" aria-labelledby="creators-title">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-5 py-4">
          <h2 id="creators-title">Creators on Amazon</h2>
          <span className="text-sm text-muted-foreground">
            {sum.clicks.toLocaleString("en-US")} clicks · {sum.purchases.toLocaleString("en-US")} orders · {formatDollars(sum.sales)}
          </span>
          <nav aria-label="Period" className="ml-auto flex gap-1.5">
            {PERIODS.map((option) => (
              <Link key={option.key} href={option.key === "30" ? "/reports/amazon" : `/reports/amazon?period=${option.key}`} className="chip" aria-current={option.key === period.key ? "true" : undefined}>
                {option.label}
              </Link>
            ))}
          </nav>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Creator</TableHead>
              <TableHead className="text-right">Clicks</TableHead>
              <TableHead className="text-right">Page views</TableHead>
              <TableHead className="text-right">Add to cart</TableHead>
              <TableHead className="text-right">Orders</TableHead>
              <TableHead className="text-right">Units</TableHead>
              <TableHead className="text-right">Sales</TableHead>
              <TableHead className="text-right">Conversion</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {creators.length === 0 ? (
              <EmptyRow colSpan={8}>No tracking links yet. Open a creator, add their Amazon tracking link, then import the Attribution report here.</EmptyRow>
            ) : (
              creators.map((row) => {
                const conversion = conversionRate(row.totals);
                return (
                  <TableRow key={row.id}>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <Avatar name={row.name} className="size-8 text-[11px]" />
                        <div className="min-w-0">
                          <CreatorName id={row.id} name={row.name} className="font-bold text-foreground hover:text-primary-text" />
                          <div className="truncate text-xs text-muted-foreground">
                            {[...row.campaigns].join(", ")}
                            {row.links > 1 ? ` · ${row.links} links` : ""}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.totals.clicks.toLocaleString("en-US")}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.totals.detailPageViews.toLocaleString("en-US")}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.totals.addToCarts.toLocaleString("en-US")}</TableCell>
                    <TableCell className="text-right font-bold tabular-nums">{row.totals.purchases.toLocaleString("en-US")}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.totals.unitsSold.toLocaleString("en-US")}</TableCell>
                    <TableCell className="text-right font-bold tabular-nums">{formatDollars(row.totals.productSales)}</TableCell>
                    <TableCell className="text-right tabular-nums" title={conversion === null ? "Under 10 clicks: too few to read" : undefined}>
                      {conversion === null ? <span className="text-muted-foreground">–</span> : `${conversion}%`}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </section>

      <section className="card mb-6 overflow-hidden" aria-labelledby="units-title">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b px-5 py-4">
          <h2 id="units-title">Units sold by month</h2>
          <span className="text-sm text-muted-foreground">From the Business Report; in brackets, units Amazon Attribution counted for creator links to those products.</span>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Product</TableHead>
              {units.months.map((month) => (
                <TableHead key={month.toISOString()} className="text-right">
                  {monthLabel(month)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {!units.imported.some(Boolean) ? (
              <EmptyRow colSpan={units.months.length + 1}>No Business Report imported yet. Upload last month&apos;s file above.</EmptyRow>
            ) : (
              <>
                {units.groups.map((group) => (
                  <TableRow key={group.title}>
                    <TableCell className="font-semibold">{group.title}</TableCell>
                    {units.months.map((month, at) => (
                      <TableCell key={month.toISOString()} className="text-right tabular-nums">
                        {units.imported[at] && group.units[at] ? group.units[at].toLocaleString("en-US") : <span className="text-muted-foreground">–</span>}
                        {group.fromCreators[at] ? <span className="ml-1 text-xs font-semibold text-primary-text">({group.fromCreators[at]})</span> : null}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                <TableRow className="bg-surface-2/60 font-bold">
                  <TableCell>All products</TableCell>
                  {units.months.map((month, at) => (
                    <TableCell key={month.toISOString()} className="text-right tabular-nums">
                      {units.imported[at] ? (
                        <>
                          <div>{units.totals.units[at].toLocaleString("en-US")}</div>
                          <div className="text-xs font-semibold text-muted-foreground">{formatDollars(units.totals.sales[at])}</div>
                        </>
                      ) : (
                        <span className="text-xs font-semibold text-muted-foreground" title="No Business Report imported for this month">not imported</span>
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              </>
            )}
          </TableBody>
        </Table>
        <p className="border-t px-5 py-3 text-xs text-muted-foreground">
          Amazon finalises a month about two days after it ends; import it from the 3rd for final numbers. A summary Attribution file is spread evenly over the days it covers.
        </p>
      </section>

      <section className="card overflow-hidden" aria-labelledby="imports-title">
        <div className="border-b px-5 py-4">
          <h2 id="imports-title">Recent imports</h2>
        </div>
        {imports.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted-foreground">Nothing imported yet.</p>
        ) : (
          <ul className="divide-y">
            {imports.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm">
                <span className="font-bold">{entry.kind === "attribution" ? "Attribution" : "Business Report"}</span>
                <span className="text-muted-foreground">
                  {brandName(entry.brandId)} · {isoDay(entry.periodStart)} to {isoDay(entry.periodEnd)} · {entry.matched} of {entry.rows} rows matched
                </span>
                <span className="ml-auto text-xs text-muted-foreground">
                  {entry.importedBy.name}, {formatDateTime(entry.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
