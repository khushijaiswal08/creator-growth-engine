import { cn } from "cn";
import type { Metadata } from "next";
import Link from "next/link";
import { AutoSubmitSelect } from "@/components/auto-submit-select";
import { Avatar } from "@/components/avatar";
import { PageHeader } from "@/components/panel";
import { ReportTabs } from "@/components/report-tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { viewed } from "@/lib/brand-scope";
import { brandName } from "@/lib/brands";
import { db } from "@/lib/db";
import { dayValueInZone, formatCount, formatDay, startOfWeekInZone } from "@/lib/format";
import { bucketsFor, FIGURE_LABELS, figuresFor, PERIOD_KEYS, PERIOD_LABELS, previousPeriod, readingFiguresFor, resolvePeriod, type Figures } from "@/lib/performance-stats";
import { displayHandle } from "@/lib/profile-url";
import { requireUser } from "@/lib/session";
import { trackRecordFor } from "@/lib/track-record";

export const metadata: Metadata = { title: "Performance" };

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_WEEKS = 8;
const TOP = 8;
const TABLE_KEYS: (keyof Figures)[] = ["messages", "replies", "contacted", "agreed", "giftsShipped", "giftsDelivered", "posted", "noContent", "contentRate"];

function show(key: keyof Figures, value: number | null): string {
  if (key === "contentRate") return value === null ? "–" : `${value}%`;
  return String(value ?? 0);
}

/** Up in green, down in red, the same in grey. Points for the rate, counts for the rest. */
function Delta({ now, before, points = false, suffix = "vs previous" }: { now: number | null; before: number | null; points?: boolean; suffix?: string }) {
  if (now === null || before === null) return <span className="chip border-transparent bg-surface-2">no earlier period</span>;
  const delta = now - before;
  if (delta === 0) return <span className="chip border-transparent bg-surface-2">same {suffix}</span>;
  const up = delta > 0;
  return (
    <span className={cn("chip border-transparent", up ? "bg-success-soft text-success-text" : "bg-danger-soft text-danger-text")}>
      {up ? "▲" : "▼"} {Math.abs(delta)}
      {points ? " pts" : ""} {suffix}
    </span>
  );
}

/**
 * The performance report: one period (week, month, quarter or custom dates),
 * per brand and campaign, with the previous period beside it, an eight-week
 * trend of messages and replies, where creators drop off, the top creators of
 * the period and the week-by-week table. Attributed orders arrive with the
 * Amazon imports in Phase B.
 */
export default async function PerformancePage({ searchParams }: { searchParams: Promise<{ period?: string; from?: string; to?: string; campaign?: string }> }) {
  const user = await requireUser();
  const view = viewed(user);
  const params = await searchParams;
  const now = new Date();
  const period = resolvePeriod(params.period, params.from, params.to, now);
  const campaigns = await db.campaign.findMany({ where: { ...view.campaigns, status: { not: "archived" } }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  const chosen = campaigns.find((campaign) => campaign.id === params.campaign) ?? null;
  const where = chosen ? { id: chosen.id } : view.campaigns;
  const href = (overrides: Record<string, string | undefined>) => {
    const query = new URLSearchParams();
    const merged = { period: period.key, from: params.from, to: params.to, campaign: chosen?.id, ...overrides };
    for (const [key, value] of Object.entries(merged)) if (value) query.set(key, value);
    return `/reports/performance?${query}`;
  };
  const thisWeek = startOfWeekInZone(now);
  const trendPeriod = { key: "trend", label: "trend", from: new Date(thisWeek.getTime() - (TREND_WEEKS - 1) * 7 * DAY_MS), to: new Date(thisWeek.getTime() + 7 * DAY_MS) };
  const inPeriod = { gte: period.from, lt: period.to };

  const earlier = previousPeriod(period);
  const messagedIn = (range: { from: Date; to: Date }) => db.message.groupBy({ by: ["campaignCreatorId"], where: { direction: "outbound", sentAt: { gte: range.from, lt: range.to }, campaignCreator: { campaign: where } } });
  const [figures, before, buckets, trend, postsByCreator, messagedNow, messagedBefore] = await Promise.all([
    figuresFor(period, where),
    figuresFor(earlier, where),
    bucketsFor(period, where),
    bucketsFor(trendPeriod, where),
    db.post.groupBy({ by: ["campaignCreatorId"], where: { createdAt: inPeriod, campaignCreator: { campaign: where } }, _count: { _all: true }, orderBy: { _count: { campaignCreatorId: "desc" } }, take: TOP * 2 }),
    messagedIn(period),
    messagedIn(earlier),
  ]);
  const [reading, readingBefore] = await Promise.all([readingFiguresFor(period, where), readingFiguresFor(earlier, where)]);
  // Reply rate the way the outreach report defines it: replies divided by the creators messaged in the period.
  const replyRateNow = messagedNow.length > 0 ? Math.round((figures.replies / messagedNow.length) * 100) : null;
  const replyRateBefore = messagedBefore.length > 0 ? Math.round((before.replies / messagedBefore.length) * 100) : null;

  // The creators behind the period's posts, with the figures that rank them.
  const topLinks = postsByCreator.length
    ? await db.campaignCreator.findMany({
        where: { id: { in: postsByCreator.map((row) => row.campaignCreatorId) } },
        select: {
          id: true,
          lastContactedAt: true,
          influencer: {
            select: { id: true, name: true, amazonTier: true, amazonMonthlyGmvUsd: true, profiles: { select: { handle: true, followers: true, engagementRate: true }, orderBy: { platform: "asc" }, take: 1 } },
          },
        },
      })
    : [];
  const top = postsByCreator
    .map((row) => ({ posts: row._count._all, link: topLinks.find((link) => link.id === row.campaignCreatorId) }))
    .filter((row): row is { posts: number; link: NonNullable<typeof row.link> } => Boolean(row.link))
    .sort((a, b) => b.posts - a.posts || Number(b.link.influencer.amazonMonthlyGmvUsd ?? 0) - Number(a.link.influencer.amazonMonthlyGmvUsd ?? 0))
    .slice(0, TOP);
  // Their all-time content rate: collaborations that ended in a post, over those that ended at all.
  const records = await trackRecordFor(top.map((row) => row.link.influencer.id), view);
  const contentRateOf = (influencerId: string): number | null => {
    const record = records.get(influencerId);
    const ended = (record?.delivered ?? 0) + (record?.noContent ?? 0);
    return record && ended > 0 ? Math.round((record.delivered / ended) * 100) : null;
  };

  // "Email to my manager": the headline figures in a plain message the mail app opens.
  const subject = `Creator Growth: ${period.label}${chosen ? `, ${chosen.name}` : ""}`;
  const body = [
    `${view.brandId ? brandName(view.brandId) : "Both brands"} · ${period.label}, ${formatDay(period.from)} to ${formatDay(new Date(period.to.getTime() - 1))}`,
    "",
    `Messages sent: ${figures.messages} (${before.messages} the period before)`,
    `Replies: ${figures.replies}${replyRateNow !== null ? `, reply rate ${replyRateNow}%` : ""}`,
    `Agreed: ${figures.agreed}`,
    `Gifts chosen: ${figures.giftsOrdered}, shipped: ${figures.giftsShipped}, delivered: ${figures.giftsDelivered}`,
    `Content posted: ${figures.posted}, no content: ${figures.noContent}${figures.contentRate !== null ? `, content rate ${figures.contentRate}%` : ""}`,
    "",
    `Full report: ${process.env.APP_URL ?? ""}${href({})}`,
  ].join("\n");
  const mailto = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  // Where creators drop off: each step as a share of the first.
  const funnel = [
    { label: "Contacted", value: figures.contacted, color: "bg-[#93c5fd]" },
    { label: "Replied", value: figures.replies, color: "bg-[#60a5fa]" },
    { label: "Agreed", value: figures.agreed, color: "bg-[#3b82f6]" },
    { label: "Gift chosen", value: figures.giftsOrdered, color: "bg-[#2563eb]" },
    { label: "Delivered", value: figures.giftsDelivered, color: "bg-[#d97706]" },
    { label: "Posted", value: figures.posted, color: "bg-[#16a34a]" },
  ];
  const widest = Math.max(1, ...funnel.map((step) => step.value));
  let biggestDrop: { from: string; to: string; lost: number } | null = null;
  for (let index = 1; index < funnel.length; index += 1) {
    const lost = funnel[index - 1].value - funnel[index].value;
    if (lost > 0 && (!biggestDrop || lost > biggestDrop.lost)) biggestDrop = { from: funnel[index - 1].label, to: funnel[index].label, lost };
  }

  return (
    <>
      <PageHeader
        title="Reports"
        meta={`${view.brandId ? brandName(view.brandId) : "Both brands"}${chosen ? ` · ${chosen.name}` : ""} · ${period.label}, ${formatDay(period.from)} to ${formatDay(new Date(period.to.getTime() - 1))}, compared with the period before`}
      >
        <Button asChild variant="outline">
          <a href={href({}).replace("/reports/performance?", "/reports/performance/export?")}>Export CSV</a>
        </Button>
        <Button asChild variant="outline">
          <a href={mailto}>Email to my manager</a>
        </Button>
      </PageHeader>
      <ReportTabs current="performance" />

      <div id="report-periods" className="mb-5 flex flex-wrap items-center gap-2">
        {PERIOD_KEYS.filter((key) => key !== "custom").map((key) => (
          <Link key={key} href={href({ period: key, from: undefined, to: undefined })} className="chip" aria-current={period.key === key ? "true" : undefined}>
            {PERIOD_LABELS[key]}
          </Link>
        ))}
        <span className="mx-1 text-xs text-muted-foreground">or</span>
        <form method="get" className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="period" value="custom" />
          {chosen ? <input type="hidden" name="campaign" value={chosen.id} /> : null}
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            From
            <Input name="from" type="date" defaultValue={params.from ?? dayValueInZone(period.from)} className="h-8 w-36 max-md:h-10" />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            To
            <Input name="to" type="date" defaultValue={params.to ?? dayValueInZone(new Date(period.to.getTime() - 1))} className="h-8 w-36 max-md:h-10" />
          </label>
          <Button type="submit" size="sm" variant="outline">
            Apply
          </Button>
        </form>
        {campaigns.length > 1 ? (
          <form method="get" className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="hidden" name="period" value={period.key} />
            {params.from ? <input type="hidden" name="from" value={params.from} /> : null}
            {params.to ? <input type="hidden" name="to" value={params.to} /> : null}
            <label htmlFor="report-campaign">Campaign</label>
            <AutoSubmitSelect id="report-campaign" name="campaign" defaultValue={chosen?.id ?? ""} className="h-8 w-auto text-xs font-semibold">
              <option value="">All campaigns</option>
              {campaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.name}
                </option>
              ))}
            </AutoSubmitSelect>
          </form>
        ) : null}
      </div>

      <section id="report-tiles" aria-label="Headline figures" className="mb-5 grid grid-cols-2 gap-3 md:gap-4 xl:grid-cols-4">
        <div className="card grid gap-1.5 p-4">
          <p className="label">Messages sent</p>
          <p className="stat-number text-[28px]">{figures.messages}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Delta now={figures.messages} before={before.messages} />
            <span>{before.messages} last period</span>
          </div>
        </div>
        <div className="card grid gap-1.5 p-4">
          <p className="label">Reply rate</p>
          <p className="stat-number text-[28px]">{replyRateNow === null ? "–" : `${replyRateNow}%`}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Delta now={replyRateNow} before={replyRateBefore} points />
            <span>
              {figures.replies} {figures.replies === 1 ? "reply" : "replies"} from {messagedNow.length} creators messaged
            </span>
          </div>
        </div>
        <div className="card grid gap-1.5 p-4">
          <p className="label">Gifts delivered</p>
          <p className="stat-number text-[28px]">{figures.giftsDelivered}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Delta now={figures.giftsDelivered} before={before.giftsDelivered} />
            <span>{figures.giftsShipped} shipped</span>
          </div>
        </div>
        <div className="card grid gap-1.5 p-4">
          <p className="label">Content rate</p>
          <p className="stat-number text-[28px]">{show("contentRate", figures.contentRate)}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Delta now={figures.contentRate} before={before.contentRate} points />
            <span>
              {figures.posted} posted, {figures.noContent} no content
            </span>
          </div>
        </div>
      </section>

      <section aria-label="Rachna's reading of replies" className="mb-5 grid grid-cols-2 gap-3 md:gap-4 xl:grid-cols-3">
        <div className="card grid gap-1.5 p-4">
          <p className="label">Replies read by Rachna</p>
          <p className="stat-number text-[28px]">{reading.repliesRead}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Delta now={reading.repliesRead} before={readingBefore.repliesRead} />
            <span>{reading.hot} hot</span>
          </div>
        </div>
        <div className="card grid gap-1.5 p-4">
          <p className="label">Rachna was right</p>
          <p className="stat-number text-[28px]">{reading.accuracy === null ? "–" : `${reading.accuracy}%`}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Delta now={reading.accuracy} before={readingBefore.accuracy} points />
            <span>matched the team&apos;s choice</span>
          </div>
        </div>
        <div className="card grid gap-1.5 p-4">
          <p className="label">Hot replies answered in a day</p>
          <p className="stat-number text-[28px]">{reading.hotAnsweredInDay === null ? "–" : `${reading.hotAnsweredInDay}%`}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Delta now={reading.hotAnsweredInDay} before={readingBefore.hotAnsweredInDay} points />
            <span>of {reading.hot} hot {reading.hot === 1 ? "reply" : "replies"}</span>
          </div>
        </div>
      </section>

      <div className="mb-5 grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section className="card p-5" aria-labelledby="trend-title">
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <h2 id="trend-title">Messages and replies, week by week</h2>
            <span className="ml-auto flex items-center gap-4 text-xs text-accent-text">
              <span className="inline-flex items-center gap-1.5">
                <i aria-hidden className="inline-block size-2.5 rounded-sm bg-primary" /> Messages
              </span>
              <span className="inline-flex items-center gap-1.5">
                <i aria-hidden className="inline-block size-2.5 rounded-sm bg-[#2563eb]" /> Replies
              </span>
            </span>
          </div>
          <TrendChart points={trend.map((bucket) => ({ label: formatDay(bucket.from).replace(/, \d{4}$/, ""), messages: bucket.figures.messages, replies: bucket.figures.replies }))} />
        </section>

        <section id="report-funnel" className="card flex flex-col p-5" aria-labelledby="funnel-title">
          <h2 id="funnel-title" className="mb-3">
            Where creators drop off
          </h2>
          <ol className="grid gap-2">
            {funnel.map((step) => (
              <li key={step.label} className="grid grid-cols-[88px_minmax(0,1fr)_40px] items-center gap-2.5 text-[13px]">
                <span className="text-accent-text">{step.label}</span>
                <span aria-hidden className="block h-4 overflow-hidden rounded bg-surface-2">
                  <span className={cn("block h-full rounded", step.color)} style={{ width: `${step.value > 0 ? Math.max(3, Math.round((step.value / widest) * 100)) : 0}%` }} />
                </span>
                <span className="text-right font-semibold tabular-nums">{step.value}</span>
              </li>
            ))}
          </ol>
          <p className="mt-auto border-t pt-3 text-xs text-muted-foreground">
            {biggestDrop
              ? `Biggest drop: ${biggestDrop.from.toLowerCase()} to ${biggestDrop.to.toLowerCase()}, ${biggestDrop.lost} ${biggestDrop.lost === 1 ? "creator" : "creators"} lost in this period.`
              : "Each step counts what happened inside the period, so a creator contacted earlier and posting now appears only under Posted."}
          </p>
        </section>
      </div>

      <section className="card mb-5 overflow-hidden" aria-labelledby="top-title">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3">
          <h2 id="top-title">Top creators in this period</h2>
          <span className="text-xs text-muted-foreground">by content delivered, then Amazon sales</span>
          <Link href="/influencers/ranking" className="link ml-auto text-xs">
            Full ranking
          </Link>
        </div>
        {top.length === 0 ? (
          <p className="px-4 py-8 text-center text-muted-foreground">No content recorded in this period yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Creator</TableHead>
                <TableHead className="text-right">Posts</TableHead>
                <TableHead>Content rate</TableHead>
                <TableHead className="text-right">Followers</TableHead>
                <TableHead className="text-right">Engagement</TableHead>
                <TableHead>Amazon tier</TableHead>
                <TableHead className="text-right">Monthly sales</TableHead>
                <TableHead>Attributed orders</TableHead>
                <TableHead>Last collaboration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {top.map((row, index) => {
                const profile = row.link.influencer.profiles[0];
                const gmv = row.link.influencer.amazonMonthlyGmvUsd === null ? null : Number(row.link.influencer.amazonMonthlyGmvUsd);
                return (
                  <TableRow key={row.link.id}>
                    <TableCell className="text-muted-foreground">{index + 1}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <Avatar name={row.link.influencer.name} className="size-7 text-[11px]" />
                        <div className="min-w-0">
                          <Link href={`/influencers/${row.link.influencer.id}`} className="font-semibold hover:text-primary-text">
                            {row.link.influencer.name}
                          </Link>
                          <div className="text-xs text-muted-foreground">{profile ? displayHandle(profile.handle) : ""}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">{row.posts}</TableCell>
                    <TableCell>
                      {(() => {
                        const value = contentRateOf(row.link.influencer.id);
                        return value === null ? <span className="text-muted-foreground">–</span> : <span className={cn("chip border-transparent", value >= 80 ? "bg-success-soft text-success-text" : value >= 50 ? "bg-warning-soft text-warning-text" : "bg-danger-soft text-danger-text")}>{value}%</span>;
                      })()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{profile?.followers !== null && profile?.followers !== undefined ? formatCount(profile.followers) : "–"}</TableCell>
                    <TableCell className="text-right tabular-nums">{profile?.engagementRate !== null && profile?.engagementRate !== undefined ? `${profile.engagementRate}%` : "–"}</TableCell>
                    <TableCell>{row.link.influencer.amazonTier ?? <span className="text-muted-foreground">–</span>}</TableCell>
                    <TableCell className="text-right tabular-nums">{gmv === null ? "–" : `$${Math.round(gmv).toLocaleString("en-US")}`}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">after Amazon import</TableCell>
                    <TableCell className="text-muted-foreground">{formatDay(row.link.lastContactedAt) || "–"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </section>

      <section className="card overflow-hidden">
        <div className="border-b px-4 py-3">
          <h2>{buckets.length > 0 && buckets[0].label.startsWith("Week") ? "Week by week" : "Month by month"}</h2>
        </div>
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
      </section>
    </>
  );
}

/** Two lines over the last weeks, drawn on the server as plain SVG. */
function TrendChart({ points }: { points: { label: string; messages: number; replies: number }[] }) {
  const width = 640;
  const height = 220;
  const left = 36;
  const right = 12;
  const top = 14;
  const bottom = 32;
  const max = Math.max(5, ...points.map((point) => Math.max(point.messages, point.replies)));
  const step = points.length > 1 ? (width - left - right) / (points.length - 1) : 0;
  const x = (index: number) => left + index * step;
  const y = (value: number) => top + (height - top - bottom) * (1 - value / max);
  const line = (pick: (point: (typeof points)[number]) => number) => points.map((point, index) => `${x(index)},${y(pick(point))}`).join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((share) => Math.round(max * share));
  const summary = points.length ? `Messages went from ${points[0].messages} to ${points[points.length - 1].messages} a week, replies from ${points[0].replies} to ${points[points.length - 1].replies}.` : "No data yet.";

  return (
    <svg role="img" aria-label={summary} viewBox={`0 0 ${width} ${height}`} className="h-auto w-full">
      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={left} x2={width - right} y1={y(tick)} y2={y(tick)} stroke="#e5e7eb" strokeWidth="1" />
          <text x={left - 8} y={y(tick) + 4} textAnchor="end" fontSize="11" fill="#6b7280">
            {tick}
          </text>
        </g>
      ))}
      <polyline fill="none" stroke="#b24a6b" strokeWidth="3" strokeLinejoin="round" points={line((point) => point.messages)} />
      <polyline fill="none" stroke="#2563eb" strokeWidth="3" strokeLinejoin="round" points={line((point) => point.replies)} />
      {points.map((point, index) => (
        <g key={point.label}>
          <circle cx={x(index)} cy={y(point.messages)} r="4" fill="#b24a6b" />
          <circle cx={x(index)} cy={y(point.replies)} r="4" fill="#2563eb" />
          <text x={x(index)} y={height - 10} textAnchor={index === 0 ? "start" : index === points.length - 1 ? "end" : "middle"} fontSize="11" fill="#6b7280">
            {point.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
