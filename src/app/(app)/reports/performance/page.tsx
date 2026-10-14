import type { Metadata } from "next";
import Link from "next/link";
import { ReportTabs } from "@/components/report-tabs";
import { PageHeader, Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { viewed } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import { dayValueInZone, formatDay } from "@/lib/format";
import { bucketsFor, FIGURE_LABELS, figuresFor, PERIOD_KEYS, PERIOD_LABELS, previousPeriod, resolvePeriod, type Figures } from "@/lib/performance-stats";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Performance" };

const CARD_KEYS: (keyof Figures)[] = ["contacted", "agreed", "giftsShipped", "giftsDelivered", "posted", "noContent", "contentRate", "messages", "replies", "creatorsAdded", "giftsOrdered", "completed"];
const TABLE_KEYS: (keyof Figures)[] = ["contacted", "agreed", "giftsShipped", "giftsDelivered", "posted", "noContent", "contentRate"];

function show(key: keyof Figures, value: number | null): string {
  if (key === "contentRate") return value === null ? "–" : `${value}%`;
  return String(value ?? 0);
}

function change(key: keyof Figures, now: number | null, before: number | null): string | null {
  if (now === null || before === null) return null;
  const delta = now - before;
  if (delta === 0) return "same as before";
  const sign = delta > 0 ? "+" : "−";
  return key === "contentRate" ? `${sign}${Math.abs(delta)} points` : `${sign}${Math.abs(delta)} vs previous`;
}

/**
 * The performance dashboard: one period (week, month, quarter or custom
 * dates), per brand and campaign, with the previous period beside it and a
 * week-by-week or month-by-month table. Attributed orders arrive with the
 * Amazon imports in Phase B.
 */
export default async function PerformancePage({ searchParams }: { searchParams: Promise<{ period?: string; from?: string; to?: string; campaign?: string }> }) {
  const user = await requireUser();
  const view = viewed(user);
  const params = await searchParams;
  const period = resolvePeriod(params.period, params.from, params.to);
  const campaigns = await db.campaign.findMany({ where: { ...view.campaigns, status: { not: "archived" } }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  const chosen = campaigns.find((campaign) => campaign.id === params.campaign) ?? null;
  const where = chosen ? { id: chosen.id } : view.campaigns;

  const [figures, before, buckets] = await Promise.all([figuresFor(period, where), figuresFor(previousPeriod(period), where), bucketsFor(period, where)]);

  const href = (overrides: Record<string, string | undefined>) => {
    const query = new URLSearchParams();
    const merged = { period: period.key, from: params.from, to: params.to, campaign: chosen?.id, ...overrides };
    for (const [key, value] of Object.entries(merged)) if (value) query.set(key, value);
    return `/reports/performance?${query}`;
  };

  return (
    <>
      <PageHeader title="Performance" meta={`${period.label}: ${formatDay(period.from)} to ${formatDay(new Date(period.to.getTime() - 1))}. Each figure counts what happened inside the period.`}>
        <Button asChild variant="outline">
          <a href={href({}).replace("/reports/performance?", "/reports/performance/export?")}>Export CSV</a>
        </Button>
      </PageHeader>
      <ReportTabs current="performance" />

      <div className="mb-6 grid gap-3">
        <nav aria-label="Period" className="flex flex-wrap gap-1.5">
          {PERIOD_KEYS.filter((key) => key !== "custom").map((key) => (
            <Link key={key} href={href({ period: key, from: undefined, to: undefined })} className="chip" aria-current={period.key === key ? "true" : undefined}>
              {PERIOD_LABELS[key]}
            </Link>
          ))}
        </nav>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="period" value="custom" />
          {chosen ? <input type="hidden" name="campaign" value={chosen.id} /> : null}
          <label className="grid gap-1 text-xs text-muted-foreground">
            From
            <Input name="from" type="date" defaultValue={params.from ?? dayValueInZone(period.from)} className="h-9 w-40 max-md:h-11" />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            To
            <Input name="to" type="date" defaultValue={params.to ?? dayValueInZone(new Date(period.to.getTime() - 1))} className="h-9 w-40 max-md:h-11" />
          </label>
          <Button type="submit" size="sm" variant="outline">
            Custom dates
          </Button>
        </form>
        {campaigns.length > 1 ? (
          <nav aria-label="Campaign" className="flex flex-wrap gap-1.5">
            <Link href={href({ campaign: undefined })} className="chip" aria-current={chosen === null ? "true" : undefined}>
              All campaigns
            </Link>
            {campaigns.map((campaign) => (
              <Link key={campaign.id} href={href({ campaign: campaign.id })} className="chip" aria-current={chosen?.id === campaign.id ? "true" : undefined}>
                {campaign.name}
              </Link>
            ))}
          </nav>
        ) : null}
      </div>

      <ul className="mb-10 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {CARD_KEYS.map((key) => (
          <li key={key} className="card grid gap-1 p-4">
            <p className="eyebrow">{FIGURE_LABELS[key]}</p>
            <p className="stat-number text-[26px]">{show(key, figures[key])}</p>
            <p className="text-xs text-muted-foreground">{change(key, figures[key], before[key]) ?? "no earlier period"}</p>
          </li>
        ))}
        <li className="card grid gap-1 p-4">
          <p className="eyebrow">Attributed orders</p>
          <p className="stat-number text-[26px] text-muted-foreground">–</p>
          <p className="text-xs text-muted-foreground">Arrives with the Amazon Attribution import</p>
        </li>
      </ul>

      <Panel plain title={buckets.length > 0 && buckets[0].label.startsWith("Week") ? "Week by week" : "Month by month"}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Period</TableHead>
              {TABLE_KEYS.map((key) => (
                <TableHead key={key} className="text-right">
                  {FIGURE_LABELS[key]}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {buckets.map((bucket) => (
              <TableRow key={bucket.label}>
                <TableCell className="text-muted-foreground">{bucket.label}</TableCell>
                {TABLE_KEYS.map((key) => (
                  <TableCell key={key} className="text-right tabular-nums">
                    {show(key, bucket.figures[key])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
    </>
  );
}
