import type { CreatorStatus } from "@prisma/client";
import { cn } from "cn";
import type { Metadata } from "next";
import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { RunAutomationsButton } from "@/components/journey-forms";
import { MessageButton, MessageComposer } from "@/components/message-button";
import { CreatorStatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { runAutomationsIfStale } from "@/lib/automation";
import { activityIn, viewed } from "@/lib/brand-scope";
import { BRANDS, brandName } from "@/lib/brands";
import { db } from "@/lib/db";
import { QUEUES, dueWhere, openCampaignIn } from "@/lib/due";
import { formatDateTime, formatDay, startOfWeekInZone, timeAgo, timeOfDay, todayWords } from "@/lib/format";
import { suggestedTemplate } from "@/lib/next-action";
import { brandTargets, personStats, replyRate, todayStats } from "@/lib/outreach-stats";
import { figuresFor, previousPeriod, resolvePeriod } from "@/lib/performance-stats";
import { displayHandle } from "@/lib/profile-url";
import { requireUser } from "@/lib/session";
import { SEND_BLOCKED_STATUSES } from "@/lib/status";
import { firstName } from "@/lib/template";

export const metadata: Metadata = { title: "Home" };
export const maxDuration = 300;

const PER_QUEUE = 8;
const RECENT = 6;
const DAY = 24 * 60 * 60 * 1000;

// The journey as a funnel: each creator is counted at the furthest stage they reached, dead ends included.
const STAGES: { label: string; statuses: CreatorStatus[]; color: string }[] = [
  { label: "Candidates", statuses: ["discovered", "scored", "review_later", "rejected", "duplicate", "on_hold"], color: "bg-border-strong" },
  { label: "Approved", statuses: ["approved", "outreach_scheduled"], color: "bg-info-soft" },
  { label: "Contacted", statuses: ["contacted", "follow_up_due", "no_reply", "not_interested", "invalid_contact", "bounced", "unsubscribed", "blacklisted"], color: "bg-[#93c5fd]" },
  { label: "Replied", statuses: ["replied", "interested", "negotiating"], color: "bg-[#60a5fa]" },
  { label: "Agreed", statuses: ["agreed", "address_collected"], color: "bg-[#3b82f6]" },
  { label: "Gift sent", statuses: ["product_shipped", "content_expected", "no_content"], color: "bg-[#d97706]" },
  { label: "Posted", statuses: ["content_posted", "completed"], color: "bg-[#16a34a]" },
];

const WORDS = ["Nothing", "One thing", "Two things", "Three things", "Four things", "Five things", "Six things", "Seven things", "Eight things", "Nine things", "Ten things", "Eleven things", "Twelve things"];

function thingsNeedYou(total: number): string {
  if (total === 0) return "nothing needs you right now";
  if (total < WORDS.length) return `${WORDS[total].toLowerCase()} ${total === 1 ? "needs" : "need"} you today`;
  return `${total} things need you today`;
}

function lateBy(due: Date | null, now: Date): number {
  if (!due) return 0;
  return Math.max(0, Math.floor((now.getTime() - due.getTime()) / DAY));
}

/** The word on the task button: the one thing to do, not the generic "Message". */
function verbFor(queueKey: string, message: boolean): string {
  if (queueKey === "replies") return "Reply";
  if (queueKey === "selection") return "Send link";
  if (queueKey === "gifts") return "Approve";
  if (queueKey === "review") return "Review";
  return message ? "Message" : "Open";
}

export default async function TodayPage() {
  const user = await requireUser();
  const view = viewed(user);
  await runAutomationsIfStale();
  const now = new Date();
  const openCampaign = openCampaignIn(view);
  const weekStart = startOfWeekInZone(now);
  const weekEnd = new Date(weekStart.getTime() + 7 * DAY);
  const thisMonth = resolvePeriod("this-month", undefined, undefined, now);
  const lastMonth = previousPeriod(thisMonth);
  const notArchived = { influencer: { archived: false }, campaign: openCampaign };

  const [queues, groups, templates, lastRun, activities, outreachStats, lastWeek, targets, inTransit, toApprove, contentDueThisWeek, contentOverdue, month, monthBefore] = await Promise.all([
    Promise.all(
      QUEUES.map(async (queue) => {
        const where = dueWhere(view, queue.statuses, now);
        const [count, items] = await Promise.all([
          db.campaignCreator.count({ where }),
          db.campaignCreator.findMany({
            where,
            orderBy: { nextActionDueAt: "asc" },
            take: PER_QUEUE,
            select: {
              id: true,
              status: true,
              nextAction: true,
              nextActionDueAt: true,
              campaign: { select: { id: true, name: true } },
              influencer: {
                select: { id: true, name: true, profiles: { select: { id: true, platform: true, handle: true, followers: true }, orderBy: { platform: "asc" } } },
              },
            },
          }),
        ]);
        return { ...queue, count, items };
      }),
    ),
    db.campaignCreator.groupBy({ by: ["status"], where: notArchived, _count: { _all: true } }),
    db.template.findMany({ where: { archived: false }, orderBy: { name: "asc" }, select: { id: true, name: true, purpose: true, body: true } }),
    db.automationRun.findFirst({ where: { finishedAt: { not: null } }, orderBy: { startedAt: "desc" }, select: { startedAt: true } }),
    db.activity.findMany({
      where: activityIn(view, user.id),
      orderBy: { createdAt: "desc" },
      take: RECENT,
      select: { id: true, body: true, createdAt: true, automated: true, user: { select: { name: true } }, campaignCreator: { select: { campaign: { select: { name: true } } } } },
    }),
    todayStats(openCampaign, now),
    personStats({ from: new Date(weekStart.getTime() - 7 * DAY), to: weekStart }, openCampaign),
    brandTargets(BRANDS.filter((brand) => view.includes(brand.id)).map((brand) => brand.id)),
    db.giftOrder.count({ where: { ...view.gifts, status: { in: ["approved", "ordered", "shipped"] } } }),
    db.giftOrder.count({ where: { ...view.gifts, status: "needs_approval" } }),
    db.campaignCreator.count({ where: { ...notArchived, status: "content_expected", contentDueAt: { gte: weekStart, lt: weekEnd } } }),
    db.campaignCreator.count({ where: { ...notArchived, status: "content_expected", contentDueAt: { lt: now } } }),
    figuresFor(thisMonth, openCampaign),
    figuresFor(lastMonth, openCampaign),
  ]);

  const total = queues.reduce((sum, queue) => sum + queue.count, 0);
  const target = targets.get(view.brandId ?? BRANDS[0].id) ?? { daily: 0, weekly: 0 };
  // This person's own week, the way the sidebar and the weekly email count it.
  const mineWeek = outreachStats.week.find((row) => row.userId === user.id);
  const mineToday = outreachStats.today.find((row) => row.userId === user.id);
  const mineLastWeek = lastWeek.find((row) => row.userId === user.id);
  const sent = mineWeek?.messages ?? 0;
  const replies = mineWeek?.replies ?? 0;
  const rate = mineWeek ? replyRate(mineWeek) : null;

  const byStatus = new Map(groups.map((group) => [group.status, group._count._all]));
  const atStage = STAGES.map((stage) => stage.statuses.reduce((count, status) => count + (byStatus.get(status) ?? 0), 0));
  const reached = atStage.map((_, index) => atStage.slice(index).reduce((sum, count) => sum + count, 0));

  return (
    <MessageComposer templates={templates} senderName={user.name}>
      <header className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div>
          <h1 className="text-[26px]">
            Good {timeOfDay(now)}, {firstName(user.name)}
          </h1>
          <p className="mt-1 text-muted-foreground">
            {todayWords(now)} · {view.brandId ? brandName(view.brandId) : "Both brands"} · {thingsNeedYou(total)}
          </p>
        </div>
        {/* The quickest start on a phone: paste the profile link copied from Instagram. */}
        <form method="get" action="/influencers/new" className="flex w-full items-center gap-2 sm:w-auto">
          <label htmlFor="check-url" className="sr-only">
            Check a profile before messaging
          </label>
          <Input id="check-url" name="url" type="url" inputMode="url" placeholder="Paste a profile link to check a creator" required className="sm:w-80" />
          <Button type="submit">Check</Button>
        </form>
      </header>

      <section aria-label="This week at a glance" className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 xl:grid-cols-5">
        <Tile label="Messages this week" value={sent} note={target.weekly > 0 ? `of ${target.weekly} target · ${mineToday?.messages ?? 0} today` : `${mineToday?.messages ?? 0} today`}>
          {target.weekly > 0 ? <Bar value={sent} target={target.weekly} /> : null}
        </Tile>
        <Tile label="Replies" value={replies} note={rate !== null ? `${rate}% reply rate` : "no one messaged yet"}>
          <Delta value={replies - (mineLastWeek?.replies ?? 0)} suffix=" vs last week" />
        </Tile>
        <Tile label="Gifts in transit" value={inTransit} note={toApprove > 0 ? undefined : "none waiting for approval"}>
          {toApprove > 0 ? (
            <Link href="/orders" className="chip border-transparent bg-warning-soft text-warning-text hover:text-warning-text">
              {toApprove} to approve
            </Link>
          ) : null}
        </Tile>
        <Tile label="Content due this week" value={contentDueThisWeek} note={contentOverdue > 0 ? undefined : "nothing overdue"}>
          {contentOverdue > 0 ? <span className="chip border-transparent bg-danger-soft text-danger-text">{contentOverdue} overdue</span> : null}
        </Tile>
        <Tile label="Content rate, this month" value={month.contentRate === null ? "–" : `${month.contentRate}%`} note={`${month.posted} posted, ${month.noContent} no content`}>
          {month.contentRate !== null && monthBefore.contentRate !== null ? <Delta value={month.contentRate - monthBefore.contentRate} unit=" pts" suffix=" vs last month" /> : null}
        </Tile>
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section className="card overflow-hidden" aria-labelledby="tasks-title">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-4 pb-3">
            <h2 id="tasks-title">My tasks today</h2>
            <span className="chip border-transparent bg-surface-2">{total}</span>
            <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
              {lastRun ? `Checked ${formatDateTime(lastRun.startedAt)}` : "Not checked yet"}
              <RunAutomationsButton />
            </span>
          </div>
          {total > 0 ? (
            <div className="flex flex-wrap gap-1.5 px-4 pb-3">
              {queues
                .filter((queue) => queue.count > 0)
                .map((queue) => (
                  <a key={queue.key} href={`#queue-${queue.key}`} className="chip">
                    {queue.title} <span className="text-muted-foreground">{queue.count}</span>
                  </a>
                ))}
            </div>
          ) : null}

          {total === 0 ? (
            <p className="border-t px-4 py-12 text-center text-muted-foreground">All quiet. New replies, parcels and content dates show up here as they come due.</p>
          ) : (
            <div className="border-t">
              <div className="hidden grid-cols-[minmax(0,1.5fr)_150px_minmax(0,1.7fr)_110px_100px] gap-3 bg-surface-2/60 px-4 py-2 text-xs font-semibold text-muted-foreground md:grid">
                <span>Creator</span>
                <span>Stage</span>
                <span>Next step</span>
                <span>Due</span>
                <span />
              </div>
              {queues
                .filter((queue) => queue.count > 0)
                .map((queue) => (
                  <div key={queue.key} id={`queue-${queue.key}`}>
                    <div className="flex items-baseline gap-2 border-b bg-surface px-4 pt-4 pb-1.5">
                      <h3>{queue.title}</h3>
                      <span className="text-xs text-muted-foreground tabular-nums">{queue.count}</span>
                    </div>
                    {queue.items.map((item) => {
                      const handle = item.influencer.profiles[0];
                      const late = lateBy(item.nextActionDueAt, now);
                      return (
                        <div key={item.id} className="grid gap-x-3 gap-y-2 border-b px-4 py-3 hover:bg-surface-2/40 md:grid-cols-[minmax(0,1.5fr)_150px_minmax(0,1.7fr)_110px_100px] md:items-center md:py-2.5">
                          <div className="flex min-w-0 items-center gap-2.5">
                            <Avatar name={item.influencer.name} />
                            <div className="min-w-0">
                              <Link href={`/influencers/${item.influencer.id}`} className="block truncate font-semibold hover:text-primary-text">
                                {item.influencer.name}
                              </Link>
                              <div className="truncate text-xs text-muted-foreground">
                                {handle ? displayHandle(handle.handle) : item.campaign.name}
                                {handle?.followers ? ` · ${Intl.NumberFormat("en", { notation: "compact" }).format(handle.followers)}` : ""}
                              </div>
                            </div>
                          </div>
                          <div>
                            <CreatorStatusPill status={item.status} />
                          </div>
                          <div className="text-sm text-foreground max-md:text-muted-foreground">{item.nextAction ?? "Needs attention"}</div>
                          <div>
                            <span
                              title={item.nextActionDueAt ? `Since ${formatDay(item.nextActionDueAt)}` : undefined}
                              className={cn("chip border-transparent", late > 0 ? "bg-danger-soft text-danger-text" : "bg-surface-2")}
                            >
                              {late === 0 ? "Today" : late === 1 ? "1 day late" : `${late} days late`}
                            </span>
                          </div>
                          <div className="md:text-right">
                            {queue.message ? (
                              <MessageButton
                                size="sm"
                                variant={queue.key === "replies" || queue.key === "selection" || late > 0 ? "action" : "outline"}
                                label={verbFor(queue.key, true)}
                                target={{
                                  campaignCreatorId: item.id,
                                  influencerName: item.influencer.name,
                                  status: item.status,
                                  profiles: item.influencer.profiles,
                                  blockedReason: SEND_BLOCKED_STATUSES.has(item.status) ? "Do not contact." : null,
                                  purpose: suggestedTemplate(item.status, item.nextAction),
                                }}
                              />
                            ) : (
                              <Button asChild size="sm" variant={queue.key === "gifts" ? "action" : "outline"}>
                                <Link href={queue.key === "gifts" ? "/orders" : `/influencers/${item.influencer.id}`}>{verbFor(queue.key, false)}</Link>
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {queue.count > queue.items.length ? (
                      <p className="border-b px-4 py-2 text-xs text-muted-foreground">
                        Showing the {queue.items.length} who have waited longest of {queue.count}.
                      </p>
                    ) : null}
                  </div>
                ))}
            </div>
          )}
        </section>

        <div className="grid content-start gap-5">
          <section className="card p-4" aria-labelledby="funnel-title">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="funnel-title">Pipeline</h2>
              <Link href="/campaigns" className="link text-xs">
                Campaigns
              </Link>
            </div>
            {reached[0] === 0 ? (
              <p className="text-sm text-muted-foreground">No creators in an open campaign yet.</p>
            ) : (
              <ol className="grid gap-2">
                {STAGES.map((stage, index) => (
                  <li key={stage.label} className="grid grid-cols-[88px_minmax(0,1fr)_32px] items-center gap-2.5 text-[13px]">
                    <span className="text-accent-text">{stage.label}</span>
                    <span aria-hidden className="block h-4 overflow-hidden rounded bg-surface-2">
                      <span className={cn("block h-full rounded", stage.color)} style={{ width: `${Math.max(reached[index] > 0 ? 3 : 0, Math.round((reached[index] / reached[0]) * 100))}%` }} />
                    </span>
                    <span className="text-right font-semibold tabular-nums">{reached[index]}</span>
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-3 text-xs text-muted-foreground">Each creator counted at the furthest step they reached, across open campaigns.</p>
          </section>

          <section className="card p-4" aria-labelledby="activity-title">
            <h2 id="activity-title" className="mb-3">
              Team activity
            </h2>
            {activities.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing logged yet.</p>
            ) : (
              <ol className="grid gap-3">
                {activities.map((item) => (
                  <li key={item.id} className="flex gap-2.5 text-[13px]">
                    <Avatar name={item.automated ? "Automation" : item.user.name} className={cn("size-7 text-[10px]", item.automated && "bg-surface-2 text-accent-text")} />
                    <div className="min-w-0">
                      <p className="break-words">
                        <span className="font-semibold">{item.automated ? "Automation" : item.user.name}</span> · {item.body}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {timeAgo(item.createdAt, now)}
                        {item.campaignCreator ? ` · ${item.campaignCreator.campaign.name}` : ""}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      </div>
    </MessageComposer>
  );
}

/** One figure with its label, a note under it and room for a chip or a bar. */
function Tile({ label, value, note, children }: { label: string; value: number | string; note?: string; children?: React.ReactNode }) {
  return (
    <div className="card grid content-start gap-1.5 p-4">
      <p className="label">{label}</p>
      <p className="stat-number text-[28px]">{value}</p>
      {children ? <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{children}{note ? <span>{note}</span> : null}</div> : note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}

/** A thin bar: rose up to the target. */
function Bar({ value, target }: { value: number; target: number }) {
  const share = target > 0 ? Math.min(1, value / target) : 0;
  return (
    <span aria-hidden className="block h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
      <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.round(share * 100)}%` }} />
    </span>
  );
}

/** Up in green, down in red, the same in grey. */
function Delta({ value, unit = "", suffix = "" }: { value: number; unit?: string; suffix?: string }) {
  if (value === 0) return <span className="chip border-transparent bg-surface-2">same{suffix}</span>;
  const up = value > 0;
  return (
    <span className={cn("chip border-transparent", up ? "bg-success-soft text-success-text" : "bg-danger-soft text-danger-text")}>
      {up ? "▲" : "▼"} {Math.abs(value)}
      {unit}
      {suffix}
    </span>
  );
}
