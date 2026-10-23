import type { CreatorStatus } from "@prisma/client";
import { cn } from "cn";
import type { Metadata } from "next";
import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { ChhotiGreeting } from "@/components/chhoti/chhoti";
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
import { brandTargets, personStats, replyRate, todayStats } from "@/lib/outreach-stats";
import { figuresFor, previousPeriod, resolvePeriod } from "@/lib/performance-stats";
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

const WORDS = ["Nothing", "One thing", "Two things", "Three things", "Four things", "Five things", "Six things", "Seven things", "Eight things", "Nine things", "Ten things", "Eleven things", "Twelve things"];

function thingsNeedYou(total: number): string {
  if (total === 0) return "nothing needs you right now";
  if (total < WORDS.length) return `${WORDS[total].toLowerCase()} ${total === 1 ? "needs" : "need"} you today`;
  return `${total} things need you today`;
}

/** The word on the task button: the one thing to do, not the generic "Message". */
function verbFor(queueKey: string, message: boolean): string {
  if (queueKey === "replies") return "Reply";
  if (queueKey === "selection") return "Send link";
  if (queueKey === "gifts") return "Approve";
  if (queueKey === "review") return "Review";
  return message ? "Message" : "Open";
}

export default async function TodayPage({ searchParams }: { searchParams: Promise<{ queue?: string; all?: string; source?: string }> }) {
  const user = await requireUser();
  const view = viewed(user);
  const params = await searchParams;
  await runAutomationsIfStale();
  const now = new Date();
  const openCampaign = openCampaignIn(view);
  const weekStart = startOfWeekInZone(now);
  const weekEnd = new Date(weekStart.getTime() + 7 * DAY);
  const thisMonth = resolvePeriod("this-month", undefined, undefined, now);
  const lastMonth = previousPeriod(thisMonth);
  const notArchived = { influencer: { archived: false }, campaign: openCampaign };
  const activeQueue = QUEUES.some((queue) => queue.key === params.queue) ? params.queue! : null;
  // "Creator Connections" narrows the task list to creators who came through Amazon.
  const amazonOnly = params.source === "amazon";
  const showAll = params.all === "1" || activeQueue !== null || amazonOnly;
  const amazonInfluencer = { archived: false, amazonTier: { not: null } };
  const ccWhere = { campaign: openCampaign, influencer: amazonInfluencer };

  const [queues, groups, templates, lastRun, activities, outreachStats, lastWeek, targets, inTransit, toApprove, contentDueThisWeek, contentOverdue, month, monthBefore, openCampaigns, amazonWaiting, ccTotal, ccToContact, ccMoved, ccPosted, ccDue] = await Promise.all([
    Promise.all(
      QUEUES.map(async (queue) => {
        const where = amazonOnly ? { ...dueWhere(view, queue.statuses, now), influencer: amazonInfluencer } : dueWhere(view, queue.statuses, now);
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
    db.campaignCreator.count({ where: { ...notArchived, status: "content_expected", contentDueAt: { gte: weekStart, lt: weekEnd } } }),
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
    db.campaignCreator.count({ where: { ...ccWhere, status: { in: ["discovered", "scored", "review_later", "approved", "outreach_scheduled"] } } }),
    db.campaignCreator.count({ where: { ...ccWhere, messages: { some: { channel: { in: ["dm", "email"] } } } } }),
    db.campaignCreator.count({ where: { ...ccWhere, status: { in: ["content_posted", "completed"] } } }),
    db.campaignCreator.count({ where: { ...dueWhere(view, QUEUES.flatMap((queue) => queue.statuses), now), influencer: amazonInfluencer } }),
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
      };
    }),
  );
  const shown = rows.length;
  const funnelCampaign = openCampaigns.length === 1 ? openCampaigns[0] : null;
  // The Creator Connections page of the brand in view, or the first brand that has one.
  const amazonUrl = [...targets.values()].map((row) => row.creatorConnectionsUrl).find(Boolean) ?? AMAZON_CONSOLE_URL;

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
        <div className="flex flex-wrap items-center gap-2">
          <CheckProfileButton />
          <Button asChild variant="outline">
            <Link href="/influencers/new">Add creator</Link>
          </Button>
          <NewMessageButton />
        </div>
      </header>

      <ChhotiGreeting
        name={firstName(user.name)}
        replies={queues.find((queue) => queue.key === "replies")?.count ?? 0}
        parcels={queues.find((queue) => queue.key === "delivery")?.count ?? 0}
        total={total}
        weekSent={sent}
        weekTarget={target.weekly}
        weekKey={weekStart.toISOString().slice(0, 10)}
      />
      <section id="home-tiles" aria-label="This week at a glance" className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4 xl:grid-cols-5">
        <Tile label="Messages this week" value={sent} note={target.weekly > 0 ? `of ${target.weekly} target · ${mineToday?.messages ?? 0} today` : `${mineToday?.messages ?? 0} today`}>
          {target.weekly > 0 ? <Bar value={sent} target={target.weekly} /> : null}
        </Tile>
        <Tile label="Replies" value={replies} note={rate !== null ? `${rate}% reply rate` : "no one messaged yet"}>
          <Delta value={replies - (mineLastWeek?.replies ?? 0)} suffix=" vs last week" />
        </Tile>
        <Tile label="Gifts in transit" value={inTransit} note={toApprove > 0 ? undefined : "none waiting for approval"}>
          {toApprove > 0 ? (
            <Link href="/orders?status=needs_approval" className="chip border-transparent bg-warning-soft text-warning-text hover:text-warning-text">
              {toApprove} to approve
            </Link>
          ) : null}
        </Tile>
        <Tile label="Content due this week" value={contentDueThisWeek} note={contentOverdue > 0 ? `${Math.max(0, contentDueThisWeek - contentOverdue)} on track` : "nothing overdue"}>
          {contentOverdue > 0 ? <span className="chip border-transparent bg-danger-soft text-danger-text">{contentOverdue} overdue</span> : null}
        </Tile>
        <Tile label="Content rate" value={month.contentRate === null ? "–" : `${month.contentRate}%`} note={month.contentRate !== null && monthBefore.contentRate !== null ? "vs last month" : `${month.posted} posted, ${month.noContent} no content this month`}>
          {month.contentRate !== null && monthBefore.contentRate !== null ? <Delta value={month.contentRate - monthBefore.contentRate} unit=" pts" /> : null}
        </Tile>
      </section>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section id="tasks-card" className="card overflow-hidden" aria-labelledby="tasks-title">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-4 pb-3">
            <h2 id="tasks-title">My tasks today</h2>
            <span className="chip border-transparent bg-surface-2">{total}</span>
            {total > 0 || amazonOnly ? (
              <div className="ml-auto flex flex-wrap gap-1.5">
                <Link href="/today" className="chip" aria-current={activeQueue === null && !amazonOnly ? "true" : undefined}>
                  All {amazonOnly ? "" : total}
                </Link>
                {queues
                  .filter((queue) => queue.count > 0)
                  .map((queue) => (
                    <Link key={queue.key} href={`/today?queue=${queue.key}${amazonOnly ? "&source=amazon" : ""}`} className="chip" aria-current={activeQueue === queue.key ? "true" : undefined}>
                      {QUEUE_CHIPS[queue.key] ?? queue.title} {queue.count}
                    </Link>
                  ))}
                {ccTotal > 0 ? (
                  <Link href="/today?source=amazon" className="chip" aria-current={amazonOnly ? "true" : undefined}>
                    Creator Connections {ccDue}
                  </Link>
                ) : null}
              </div>
            ) : null}
          </div>

          {amazonWaiting > 0 ? (
            <div className="flex flex-wrap items-center gap-3 border-t bg-warning-soft/40 px-4 py-2.5 text-sm">
              <span aria-hidden className="flex size-7 items-center justify-center rounded-full bg-warning-soft text-[12px] font-bold text-warning-text">
                a
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">Check Amazon messages</p>
                <p className="text-xs text-muted-foreground">
                  {amazonWaiting} {amazonWaiting === 1 ? "creator was" : "creators were"} written to inside Creator Connections. Amazon does not tell us when they answer: open the thread, then press Log a reply on the creator.
                </p>
              </div>
              <Button asChild size="sm" variant="outline">
                <a href={amazonUrl} target="_blank" rel="noopener noreferrer">
                  Open Amazon
                </a>
              </Button>
            </div>
          ) : null}
          {total === 0 ? (
            <p className="border-t px-4 py-12 text-center text-muted-foreground">
              {amazonOnly ? "No Creator Connections creator needs you today." : "All quiet. New replies, parcels and content dates show up here as they come due."}
            </p>
          ) : (
            <TaskList rows={rows} />
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2.5 text-xs text-muted-foreground">
            {total > shown ? (
              <Link href={activeQueue ? `/today?queue=${activeQueue}&all=1` : "/today?all=1"} className="link">
                Show all {total} tasks
              </Link>
            ) : (
              <span>{total === 0 ? "" : `Showing all ${shown}`}</span>
            )}
            <span className="flex items-center gap-3">
              {lastRun ? `Checked ${timeAgo(lastRun.startedAt, now)}` : "Not checked yet"}
              <RunAutomationsButton />
            </span>
          </div>
        </section>

        <div id="home-side" className="grid content-start gap-5">
          {ccTotal > 0 ? (
            <section className="card p-4" aria-labelledby="cc-title">
              <div className="mb-1 flex items-center justify-between">
                <h2 id="cc-title">Creator Connections</h2>
                <a href={amazonUrl} target="_blank" rel="noopener noreferrer" className="link text-xs">
                  Open Amazon
                </a>
              </div>
              <p className="mb-3 text-xs text-muted-foreground">
                {ccTotal} {ccTotal === 1 ? "creator" : "creators"} from Amazon in open campaigns
              </p>
              <dl className="grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-surface-2/70 px-3 py-2">
                  <dt className="text-[11px] font-semibold text-muted-foreground">Need you today</dt>
                  <dd className="stat-number text-[20px]">{ccDue}</dd>
                </div>
                <div className="rounded-lg bg-surface-2/70 px-3 py-2">
                  <dt className="text-[11px] font-semibold text-muted-foreground">Not messaged yet</dt>
                  <dd className="stat-number text-[20px]">{ccToContact}</dd>
                </div>
                <div className="rounded-lg bg-warning-soft/60 px-3 py-2">
                  <dt className="text-[11px] font-semibold text-warning-text">Waiting inside Amazon</dt>
                  <dd className="stat-number text-[20px]">{amazonWaiting}</dd>
                </div>
                <div className="rounded-lg bg-info-soft/70 px-3 py-2">
                  <dt className="text-[11px] font-semibold text-info-text">Moved to DM or email</dt>
                  <dd className="stat-number text-[20px]">{ccMoved}</dd>
                </div>
                <div className="rounded-lg bg-success-soft/70 px-3 py-2">
                  <dt className="text-[11px] font-semibold text-success-text">Posted</dt>
                  <dd className="stat-number text-[20px]">{ccPosted}</dd>
                </div>
                <div className="rounded-lg bg-surface-2/70 px-3 py-2">
                  <dt className="text-[11px] font-semibold text-muted-foreground">Tasks</dt>
                  <dd>
                    <Link href="/today?source=amazon" className="link text-sm">
                      See theirs
                    </Link>
                  </dd>
                </div>
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">Message them once inside Amazon with the Amazon template, ask for an email or handle, then carry on from here.</p>
            </section>
          ) : null}
          <section className="card p-4" aria-labelledby="funnel-title">
            <div className="mb-1 flex items-center justify-between">
              <h2 id="funnel-title">Pipeline</h2>
              <Link href={funnelCampaign ? `/campaigns/${funnelCampaign.id}` : "/campaigns"} className="link text-xs">
                {funnelCampaign ? "Open board" : "Open boards"}
              </Link>
            </div>
            <p className="mb-3 text-xs text-muted-foreground">{funnelCampaign ? funnelCampaign.name : `${openCampaigns.length} open ${openCampaigns.length === 1 ? "campaign" : "campaigns"}`}</p>
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
      {children ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {children}
          {note ? <span>{note}</span> : null}
        </div>
      ) : note ? (
        <p className="text-xs text-muted-foreground">{note}</p>
      ) : null}
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
