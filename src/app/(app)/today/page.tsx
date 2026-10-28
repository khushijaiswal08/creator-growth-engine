import type { CreatorStatus } from "@prisma/client";
import { cn } from "cn";
import { Check, ChevronRight, Clapperboard, Clock, ExternalLink, MessageCircle, Plus, Reply, ShoppingBag, Truck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { RachnaGreeting } from "@/components/rachna/rachna";
import { RachnaPick } from "@/components/rachna/rachna-pick";
import { QueueTabs, type QueueTab } from "@/components/queue-tabs";
import { CheckProfileButton, NewMessageButton } from "@/components/home-actions";
import { RunAutomationsButton } from "@/components/journey-forms";
import { MessageComposer } from "@/components/message-button";
import { TaskList, type TaskRow } from "@/components/task-list";
import { Button } from "@/components/ui/button";
import { runAutomationsIfStale } from "@/lib/automation";
import { activityIn, viewed } from "@/lib/brand-scope";
import { BRANDS, brandName } from "@/lib/brands";
import { AMAZON_CONSOLE_URL } from "@/lib/channels";
import { db } from "@/lib/db";
import { QUEUES, dueWhere, openCampaignIn } from "@/lib/due";
import { startOfWeekInZone, timeAgo, timeOfDay, todayWords } from "@/lib/format";
import { suggestedTemplate } from "@/lib/next-action";
import { brandTargets, personStats, todayStats } from "@/lib/outreach-stats";
import { figuresFor, previousPeriod, resolvePeriod } from "@/lib/performance-stats";
import { pickFor } from "@/lib/rachna";
import { isWarmth, warmthRank } from "@/lib/reply-reader";
import { requireUser } from "@/lib/session";
import { SEND_BLOCKED_STATUSES } from "@/lib/status";
import { firstName } from "@/lib/template";

export const metadata: Metadata = { title: "Home" };
export const maxDuration = 300;

const PER_QUEUE = 8;
const ALL = 60;
const RECENT = 6;
const DAY = 24 * 60 * 60 * 1000;

// Short chip names for the queues, in the order they are shown.
const QUEUE_CHIPS: Record<string, string> = {
  replies: "Replies",
  selection: "Links",
  followups: "Follow-ups",
  first: "First messages",
  gifts: "Gifts",
  delivery: "Parcels",
  content: "Content",
  posted: "Posts",
  review: "Review",
};

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

/** The word on the task button: the one thing to do, not the generic "Message". */
function verbFor(queueKey: string, message: boolean): string {
  if (queueKey === "replies") return "Reply";
  if (queueKey === "selection") return "Send link";
  if (queueKey === "gifts") return "Approve";
  if (queueKey === "review") return "Review";
  return message ? "Message" : "Open";
}

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ queue?: string; all?: string; source?: string; hot?: string }> }) {
  const user = await requireUser();
  const view = viewed(user);
  const params = await searchParams;
  await runAutomationsIfStale();
  const now = new Date();
  const openCampaign = openCampaignIn(view);
  const weekStart = startOfWeekInZone(now);
  const thisMonth = resolvePeriod("this-month", undefined, undefined, now);
  const lastMonth = previousPeriod(thisMonth);
  const notArchived = { influencer: { archived: false }, campaign: openCampaign };
  const activeQueue = QUEUES.some((queue) => queue.key === params.queue) ? params.queue! : null;
  // "Creator Connections" narrows the task list to creators who came through Amazon.
  const amazonOnly = params.source === "amazon";
  // "Hot" narrows the list to creators whose latest reply Rachna read as keen.
  const hotOnly = params.hot === "1";
  const showAll = params.all === "1" || activeQueue !== null || amazonOnly || hotOnly;
  const amazonInfluencer = { archived: false, amazonTier: { not: null } };
  const ccWhere = { campaign: openCampaign, influencer: amazonInfluencer };

  const [queues, groups, templates, lastRun, activities, outreachStats, lastWeek, targets, inTransit, toApprove, contentOverdue, month, monthBefore, openCampaigns, amazonWaiting, ccTotal, ccPosted, ccDue, hotTotal] = await Promise.all([
    Promise.all(
      QUEUES.map(async (queue) => {
        const where = { ...dueWhere(view, queue.statuses, now), ...(amazonOnly ? { influencer: amazonInfluencer } : {}), ...(hotOnly ? { replyWarmth: "hot" } : {}) };
        const [count, items] = await Promise.all([
          db.campaignCreator.count({ where }),
          activeQueue && activeQueue !== queue.key
            ? []
            : db.campaignCreator.findMany({
                where,
                orderBy: { nextActionDueAt: "asc" },
                take: showAll ? ALL : PER_QUEUE,
                select: {
                  id: true,
                  status: true,
                  nextAction: true,
                  nextActionDueAt: true,
                  replyWarmth: true,
                  replyRead: true,
                  campaign: { select: { name: true } },
                  influencer: { select: { id: true, name: true, email: true, amazonTier: true, profiles: { select: { id: true, platform: true, handle: true, followers: true }, orderBy: { platform: "asc" } } } },
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
    db.campaignCreator.count({ where: { ...notArchived, status: "content_expected", contentDueAt: { lt: now } } }),
    figuresFor(thisMonth, openCampaign),
    figuresFor(lastMonth, openCampaign),
    db.campaign.findMany({ where: openCampaign, orderBy: { updatedAt: "desc" }, select: { id: true, name: true } }),
    // Creators written to inside Amazon Creator Connections who may have answered there: Amazon never tells us.
    db.campaignCreator.count({
      where: { ...ccWhere, status: { in: ["contacted", "follow_up_due", "replied", "interested", "negotiating", "agreed"] }, messages: { some: { channel: "amazon" } } },
    }),
    // The Creator Connections column: where the Amazon creators stand.
    db.campaignCreator.count({ where: ccWhere }),
    db.campaignCreator.count({ where: { ...ccWhere, status: { in: ["content_posted", "completed"] } } }),
    db.campaignCreator.count({ where: { ...dueWhere(view, QUEUES.flatMap((queue) => queue.statuses), now), influencer: amazonInfluencer } }),
    db.campaignCreator.count({ where: { ...dueWhere(view, QUEUES.flatMap((queue) => queue.statuses), now), replyWarmth: "hot" } }),
  ]);

  const total = queues.reduce((sum, queue) => sum + queue.count, 0);
  const target = targets.get(view.brandId ?? BRANDS[0].id) ?? { daily: 0, weekly: 0 };
  // This person's own week, the way the sidebar and the weekly email count it.
  const mineWeek = outreachStats.week.find((row) => row.userId === user.id);
  const mineToday = outreachStats.today.find((row) => row.userId === user.id);
  const mineLastWeek = lastWeek.find((row) => row.userId === user.id);
  const sent = mineWeek?.messages ?? 0;
  const replies = mineWeek?.replies ?? 0;

  const byStatus = new Map(groups.map((group) => [group.status, group._count._all]));
  const atStage = STAGES.map((stage) => stage.statuses.reduce((count, status) => count + (byStatus.get(status) ?? 0), 0));
  const reached = atStage.map((_, index) => atStage.slice(index).reduce((sum, count) => sum + count, 0));

  // One flat list, most urgent queue first, longest wait first inside each.
  const rows: TaskRow[] = queues.flatMap((queue) =>
    queue.items.map((item) => {
      const handle = item.influencer.profiles[0];
      const lateDays = item.nextActionDueAt ? Math.max(0, Math.floor((now.getTime() - item.nextActionDueAt.getTime()) / DAY)) : 0;
      return {
        id: item.id,
        queue: queue.key,
        influencerId: item.influencer.id,
        name: item.influencer.name,
        handle: handle ? `@${handle.handle}` : null,
        followers: handle?.followers ?? null,
        status: item.status,
        nextAction: item.nextAction ?? "Needs attention",
        dueAt: item.nextActionDueAt,
        lateDays,
        verb: verbFor(queue.key, queue.message),
        primary: queue.key === "replies" || queue.key === "selection" || queue.key === "gifts" || lateDays > 0,
        href: queue.message ? null : queue.key === "gifts" ? "/orders?status=needs_approval" : `/influencers/${item.influencer.id}`,
        profiles: item.influencer.profiles.map(({ id, platform, handle }) => ({ id, platform, handle })),
        email: item.influencer.email,
        amazonCreator: item.influencer.amazonTier !== null,
        blockedReason: SEND_BLOCKED_STATUSES.has(item.status) ? "Do not contact." : null,
        purpose: suggestedTemplate(item.status, item.nextAction),
        campaignName: item.campaign.name,
        warmth: isWarmth(item.replyWarmth) ? item.replyWarmth : null,
        readSummary: item.replyRead,
      };
    }),
  );
  // Inside each queue the hot replies come first; the sort is stable, so the due order holds otherwise.
  rows.sort((a, b) => QUEUES.findIndex((queue) => queue.key === a.queue) - QUEUES.findIndex((queue) => queue.key === b.queue) || warmthRank(a.warmth) - warmthRank(b.warmth));
  const shown = rows.length;
  const funnelCampaign = openCampaigns.length === 1 ? openCampaigns[0] : null;
  // The Creator Connections page of the brand in view, or the first brand that has one.
  const amazonUrl = [...targets.values()].map((row) => row.creatorConnectionsUrl).find(Boolean) ?? AMAZON_CONSOLE_URL;

  // The tabs across the list: the busiest queues up front, the rest under More.
  const FRONT = ["replies", "selection", "gifts"];
  const href = (queue: string | null, extra = "") => `/today${queue ? `?queue=${queue}${extra}` : extra ? `?${extra.slice(1)}` : ""}`;
  const queueTabs: QueueTab[] = [
    { key: "all", label: "All", count: total, href: "/today", active: activeQueue === null && !amazonOnly && !hotOnly },
    ...(hotTotal > 0 ? [{ key: "hot", label: "Hot", count: hotTotal, href: "/today?hot=1", active: hotOnly, hot: true }] : []),
    ...FRONT.map((key) => {
      const queue = queues.find((item) => item.key === key)!;
      return { key, label: QUEUE_CHIPS[key], count: queue.count, href: href(key), active: activeQueue === key };
    }),
  ];
  const moreTabs: QueueTab[] = [
    ...queues.filter((queue) => !FRONT.includes(queue.key) && queue.count > 0).map((queue) => ({ key: queue.key, label: QUEUE_CHIPS[queue.key] ?? queue.title, count: queue.count, href: href(queue.key), active: activeQueue === queue.key })),
    ...(ccTotal > 0 ? [{ key: "amazon", label: "Creator Connections", count: ccDue, href: "/today?source=amazon", active: amazonOnly }] : []),
  ];
  const funnelSteps = STAGES.slice(2);
  const funnelTop = reached[2] || 1;

  return (
    <MessageComposer templates={templates} senderName={user.name}>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="min-w-0">
          <h1>
            Good {timeOfDay(now)}, {firstName(user.name)}
          </h1>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[15px] font-medium text-muted-foreground">
            <span>
              {todayWords(now)}
              {view.brandId ? ` · ${brandName(view.brandId)}` : ""}
            </span>
            {total > 0 ? (
              <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-danger-soft px-3 text-[13px] font-extrabold text-danger-text">
                <Clock className="size-3.5" strokeWidth={2.5} />
                {total.toLocaleString("en-US")} to do
              </span>
            ) : (
              <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-success-soft px-3 text-[13px] font-extrabold text-success-text">
                <Check className="size-3.5" strokeWidth={3} />
                All clear
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <CheckProfileButton />
          <Button asChild variant="outline">
            <Link href="/influencers/new">
              <Plus className="size-[17px]" strokeWidth={2.2} />
              Add creator
            </Link>
          </Button>
          <NewMessageButton />
        </div>
      </header>

      <RachnaGreeting
        name={firstName(user.name)}
        replies={queues.find((queue) => queue.key === "replies")?.count ?? 0}
        parcels={queues.find((queue) => queue.key === "delivery")?.count ?? 0}
        total={total}
        weekSent={sent}
        weekTarget={target.weekly}
        weekKey={weekStart.toISOString().slice(0, 10)}
      />
      <section id="home-tiles" aria-label="This week at a glance" className="mb-6 grid grid-cols-2 gap-3 md:gap-4 xl:grid-cols-4">
        <Kpi icon={<MessageCircle className="size-[19px]" strokeWidth={2} />} tint="bg-primary-faint text-primary" label="Messages" value={sent} of={target.weekly > 0 ? target.weekly : undefined}>
          {target.weekly > 0 ? <Bar value={sent} target={target.weekly} /> : null}
          <span>This week · {mineToday?.messages ?? 0} today</span>
        </Kpi>
        <Kpi icon={<Reply className="size-[19px]" strokeWidth={2} />} tint="bg-info-soft text-info-text" label="Replies" value={replies}>
          <Delta value={replies - (mineLastWeek?.replies ?? 0)} />
          <span>vs last week</span>
        </Kpi>
        <Kpi icon={<Truck className="size-[19px]" strokeWidth={2} />} tint="bg-warning-soft text-warning-text" label="In transit" value={inTransit}>
          {toApprove > 0 ? (
            <Link href="/orders?status=needs_approval" className="inline-flex h-6 items-center rounded-full bg-warning-soft px-2.5 text-xs font-extrabold text-warning-text hover:underline">
              {toApprove} to approve
            </Link>
          ) : (
            <span>none to approve</span>
          )}
        </Kpi>
        <Kpi icon={<Clapperboard className="size-[19px]" strokeWidth={2} />} tint="bg-success-soft text-success-text" label="Content rate" value={month.contentRate === null ? "–" : `${month.contentRate}%`}>
          {contentOverdue > 0 ? (
            <span className="inline-flex h-6 items-center rounded-full bg-danger-soft px-2.5 text-xs font-extrabold text-danger-text">{contentOverdue} overdue</span>
          ) : month.contentRate !== null && monthBefore.contentRate !== null ? (
            <>
              <Delta value={month.contentRate - monthBefore.contentRate} unit=" pts" />
              <span>vs last month</span>
            </>
          ) : (
            <span>{month.posted} posted this month</span>
          )}
        </Kpi>
      </section>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section id="tasks-card" className="card min-w-0 overflow-hidden" aria-labelledby="tasks-title">
          <div className="flex items-center gap-2.5 px-5 pt-5 md:px-[22px]">
            <h2 id="tasks-title">Today</h2>
            <span className="count-pill">{total.toLocaleString("en-US")}</span>
            <span className="flex-1" />
            {total > shown ? (
              <Link href={activeQueue ? `/today?queue=${activeQueue}&all=1` : "/today?all=1"} className="inline-flex items-center gap-1 text-[13px] font-bold text-primary hover:underline">
                View all
                <ChevronRight className="size-4" strokeWidth={2.4} />
              </Link>
            ) : null}
          </div>
          {total > 0 || amazonOnly || hotOnly ? <QueueTabs tabs={queueTabs} more={moreTabs} /> : <div className="mt-4 border-b" />}

          {amazonWaiting > 0 ? (
            <div className="flex flex-wrap items-center gap-3 border-b bg-warning-soft/60 px-5 py-3 text-sm md:px-[22px]">
              <span aria-hidden className="flex size-8 items-center justify-center rounded-xl bg-surface text-warning-text">
                <ShoppingBag className="size-4" strokeWidth={2.2} />
              </span>
              <p className="min-w-0 flex-1 font-semibold">
                Check Amazon messages <span className="font-medium text-muted-foreground">· {amazonWaiting} written to inside Creator Connections</span>
              </p>
              <Button asChild size="sm" variant="outline">
                <a href={amazonUrl} target="_blank" rel="noopener noreferrer">
                  Open Amazon
                  <ExternalLink className="size-3.5" />
                </a>
              </Button>
            </div>
          ) : null}
          {total === 0 ? (
            <div className="grid place-items-center gap-2 px-6 py-14 text-center">
              <span className="flex size-12 items-center justify-center rounded-full bg-success-soft text-success-text">
                <Check className="size-6" strokeWidth={2.5} />
              </span>
              <p className="text-[17px] font-extrabold text-foreground">{amazonOnly ? "No Amazon creator needs you" : hotOnly ? "No hot replies waiting" : "All clear for today"}</p>
              <p className="font-medium text-muted-foreground">{hotOnly ? "Rachna marks a reply hot when the creator sounds keen." : "New replies, parcels and content dates show up here."}</p>
            </div>
          ) : (
            <TaskList rows={rows} />
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3.5 text-[13px] font-semibold text-muted-foreground md:px-[22px]">
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>{total === 0 ? "Nothing waiting" : `Showing ${shown} of ${total.toLocaleString("en-US")}`}</span>
              <span className="flex items-center gap-1.5 font-medium">
                {lastRun ? `Checked ${timeAgo(lastRun.startedAt, now)}` : "Not checked yet"}
                <RunAutomationsButton />
              </span>
            </span>
            {total > shown ? (
              <Button asChild size="sm" variant="outline">
                <Link href={activeQueue ? `/today?queue=${activeQueue}&all=1` : "/today?all=1"}>Show all tasks</Link>
              </Button>
            ) : null}
          </div>
        </section>

        <aside id="home-side" className="grid min-w-0 grid-cols-1 content-start gap-5">
          {activeQueue === null && !amazonOnly && !hotOnly ? <RachnaPick row={pickFor(rows)} /> : null}

          <section className="card grid gap-3.5 p-5" aria-labelledby="funnel-title">
            <div className="flex items-center gap-2">
              <h3 id="funnel-title">Pipeline</h3>
              <span className="flex-1" />
              <Link href={funnelCampaign ? `/campaigns/${funnelCampaign.id}` : "/campaigns"} className="inline-flex items-center gap-1 text-[13px] font-bold text-primary hover:underline">
                {funnelCampaign ? "Open board" : "Open boards"}
                <ChevronRight className="size-4" strokeWidth={2.4} />
              </Link>
            </div>
            {reached[0] === 0 ? (
              <p className="text-sm text-muted-foreground">No creators in an open campaign yet.</p>
            ) : (
              <ol className="grid gap-2.5">
                {funnelSteps.map((stage, index) => (
                  <li key={stage.label} className="grid grid-cols-[78px_minmax(0,1fr)_48px] items-center gap-2.5 text-[13px] font-semibold">
                    <span className="text-accent-text">{stage.label}</span>
                    <span aria-hidden className="block h-2.5 overflow-hidden rounded-full bg-surface-2">
                      <span className="block h-full rounded-full" style={{ width: `${reached[index + 2] > 0 ? Math.max(4, Math.round((reached[index + 2] / funnelTop) * 100)) : 0}%`, background: FUNNEL_COLORS[index] }} />
                    </span>
                    <span className="text-right font-extrabold text-foreground tabular-nums">{reached[index + 2].toLocaleString("en-US")}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {ccTotal > 0 ? (
            <section className="card grid gap-3.5 p-5" aria-labelledby="cc-title">
              <div className="flex items-center gap-2">
                <h3 id="cc-title" className="whitespace-nowrap">
                  Creator Connections
                </h3>
                <span className="flex-1" />
                <a href={amazonUrl} target="_blank" rel="noopener noreferrer" title="Open Amazon" aria-label="Open Amazon Creator Connections" className="flex size-8 items-center justify-center rounded-[9px] border text-accent-text hover:bg-surface-2 hover:text-foreground">
                  <ExternalLink className="size-[15px]" strokeWidth={2} />
                </a>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <Link href="/today?source=amazon" className="rounded-xl bg-surface-2/80 px-3 py-2.5 hover:bg-primary-faint">
                  <b className="block text-[20px] leading-tight font-extrabold text-foreground tabular-nums">{ccDue}</b>
                  <span className="text-[11.5px] font-bold text-muted-foreground">Need you</span>
                </Link>
                <div className="rounded-xl bg-surface-2/80 px-3 py-2.5">
                  <b className="block text-[20px] leading-tight font-extrabold text-foreground tabular-nums">{amazonWaiting}</b>
                  <span className="text-[11.5px] font-bold text-muted-foreground">Waiting</span>
                </div>
                <div className="rounded-xl bg-surface-2/80 px-3 py-2.5">
                  <b className="block text-[20px] leading-tight font-extrabold text-foreground tabular-nums">{ccPosted}</b>
                  <span className="text-[11.5px] font-bold text-muted-foreground">Posted</span>
                </div>
              </div>
            </section>
          ) : null}

          <section className="card grid gap-3.5 p-5" aria-labelledby="activity-title">
            <h3 id="activity-title">Recent activity</h3>
            {activities.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing logged yet.</p>
            ) : (
              <ol className="grid gap-3.5">
                {activities.slice(0, 4).map((item) => (
                  <li key={item.id} className="flex gap-2.5 text-[13px] leading-snug">
                    <Avatar name={item.automated ? "Automation" : item.user.name} className={cn("size-7 text-[10.5px]", item.automated && "bg-surface-2 text-accent-text")} />
                    <div className="min-w-0">
                      <p className="break-words">
                        <span className="font-bold text-foreground">{item.automated ? "Automation" : firstName(item.user.name)}</span> {lowerFirst(item.body)}
                      </p>
                      <p className="text-xs font-semibold text-faint">{timeAgo(item.createdAt, now)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </aside>
      </div>
    </MessageComposer>
  );
}

const FUNNEL_COLORS = ["#c7d7fe", "#93b4fb", "#6d8ef5", "#f2b45a", "#4ade80"];

/** "Status changed from A to B." reads after a name as "status changed from A to B." */
function lowerFirst(text: string): string {
  return text.length > 1 && /^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text;
}

/** One figure: a tinted icon and a one-line label, the big number, one short line below. */
function Kpi({ icon, tint, label, value, of, children }: { icon: React.ReactNode; tint: string; label: string; value: number | string; of?: number; children?: React.ReactNode }) {
  return (
    <div className="card grid content-start gap-2.5 px-5 py-[18px]">
      <div className="flex items-center gap-3">
        <span aria-hidden className={cn("flex size-[38px] shrink-0 items-center justify-center rounded-xl", tint)}>
          {icon}
        </span>
        <span className="label truncate">{label}</span>
      </div>
      <p className="flex items-baseline gap-1">
        <span className="stat-number text-[30px] md:text-[34px]">{typeof value === "number" ? value.toLocaleString("en-US") : value}</span>
        {of !== undefined ? <span className="text-base font-bold text-faint">/ {of}</span> : null}
      </p>
      {children ? <div className="flex flex-wrap items-center gap-2 text-[13px] font-semibold text-muted-foreground">{children}</div> : null}
    </div>
  );
}

/** A thin bar: rose up to the target. */
function Bar({ value, target }: { value: number; target: number }) {
  const share = target > 0 ? Math.min(1, value / target) : 0;
  return (
    <span aria-hidden className="mb-0.5 block h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
      <span className="block h-full rounded-full bg-gradient-to-r from-[#c95f84] to-primary" style={{ width: `${Math.round(share * 100)}%` }} />
    </span>
  );
}

/** Up in green, down in red, the same in grey. */
function Delta({ value, unit = "" }: { value: number; unit?: string }) {
  if (value === 0) return <span className="inline-flex h-6 items-center rounded-full bg-surface-2 px-2.5 text-xs font-extrabold text-accent-text">same</span>;
  const up = value > 0;
  return (
    <span className={cn("inline-flex h-6 items-center rounded-full px-2.5 text-xs font-extrabold", up ? "bg-success-soft text-success-text" : "bg-danger-soft text-danger-text")}>
      {up ? "▲" : "▼"} {Math.abs(value)}
      {unit}
    </span>
  );
}
