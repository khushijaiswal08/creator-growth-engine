import type { CreatorStatus, Prisma } from "@prisma/client";
import type { Metadata } from "next";
import Link from "next/link";
import { ActivityList } from "@/components/activity-list";
import { Avatar } from "@/components/avatar";
import { RunAutomationsButton } from "@/components/journey-forms";
import { MessageButton, MessageComposer } from "@/components/message-button";
import { EmptyRow, Panel } from "@/components/panel";
import { CreatorStatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { runAutomationsIfStale } from "@/lib/automation";
import { activityIn, viewed } from "@/lib/brand-scope";
import { brandName } from "@/lib/brands";
import { db } from "@/lib/db";
import { formatDateTime, formatDay, startOfDayInZone, startOfWeekInZone, todayWords, timeOfDay } from "@/lib/format";
import { displayHandle } from "@/lib/profile-url";
import { requireUser } from "@/lib/session";
import { SEND_BLOCKED_STATUSES } from "@/lib/status";
import { firstName } from "@/lib/template";

export const metadata: Metadata = { title: "Today" };
export const maxDuration = 300;

const PER_QUEUE = 8;
const RECENT = 6;
const DAY = 24 * 60 * 60 * 1000;

// What needs a person today, most urgent first. A creator appears in one group only.
const QUEUES: { key: string; title: string; statuses: CreatorStatus[]; message: boolean }[] = [
  { key: "replies", title: "Reply today", statuses: ["replied", "negotiating"], message: true },
  { key: "selection", title: "Send the product link", statuses: ["interested", "agreed"], message: true },
  { key: "followups", title: "Follow-ups due", statuses: ["follow_up_due"], message: true },
  { key: "first", title: "First messages", statuses: ["approved", "outreach_scheduled"], message: true },
  { key: "gifts", title: "Gifts needing you", statuses: ["address_collected"], message: false },
  { key: "delivery", title: "Parcels to check", statuses: ["product_shipped"], message: false },
  { key: "content", title: "Content to chase", statuses: ["content_expected"], message: true },
  { key: "posted", title: "Posts to check", statuses: ["content_posted"], message: false },
  { key: "review", title: "To review", statuses: ["discovered", "scored"], message: false },
];

const WORDS = ["Nothing", "One thing", "Two things", "Three things", "Four things", "Five things", "Six things", "Seven things", "Eight things", "Nine things", "Ten things", "Eleven things", "Twelve things"];

function thingsNeedYou(total: number): string {
  if (total === 0) return "Nothing needs you right now.";
  if (total < WORDS.length) return `${WORDS[total]} ${total === 1 ? "needs" : "need"} you.`;
  return `${total} things need you.`;
}

function waited(due: Date | null, now: Date): string {
  if (!due) return "";
  const days = Math.floor((now.getTime() - due.getTime()) / DAY);
  if (days <= 0) return "today";
  if (days === 1) return "1 day";
  return `${days} days`;
}

export default async function TodayPage() {
  const user = await requireUser();
  const view = viewed(user);
  await runAutomationsIfStale();
  const now = new Date();
  const openCampaign = { status: { not: "archived" as const }, ...view.campaigns };

  // "Due" means a person owes the next step now: it is waiting on the team, or the wait for the creator has run out.
  const dueWhere = (statuses: CreatorStatus[]): Prisma.CampaignCreatorWhereInput => ({
    status: { in: statuses },
    campaign: openCampaign,
    influencer: { archived: false },
    nextActionDueAt: { lte: now },
  });

  const dayStart = startOfDayInZone(now);
  const weekStart = startOfWeekInZone(now);
  const sentSince = (since: Date) =>
    db.message.groupBy({
      by: ["userId"],
      where: { direction: "outbound", sentAt: { gte: since }, campaignCreator: { campaign: openCampaign } },
      _count: { _all: true },
    });

  const [queues, groups, templates, lastRun, activities, sentToday, sentThisWeek] = await Promise.all([
    Promise.all(
      QUEUES.map(async (queue) => {
        const where = dueWhere(queue.statuses);
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
                select: { id: true, name: true, profiles: { select: { id: true, platform: true, handle: true }, orderBy: { platform: "asc" } } },
              },
            },
          }),
        ]);
        return { ...queue, count, items };
      }),
    ),
    db.campaignCreator.groupBy({
      by: ["status"],
      where: { campaign: openCampaign, influencer: { archived: false } },
      _count: { _all: true },
    }),
    db.template.findMany({ where: { archived: false }, orderBy: { name: "asc" }, select: { id: true, name: true, purpose: true, body: true } }),
    db.automationRun.findFirst({ where: { finishedAt: { not: null } }, orderBy: { startedAt: "desc" }, select: { startedAt: true } }),
    db.activity.findMany({
      where: activityIn(view, user.id),
      orderBy: { createdAt: "desc" },
      take: RECENT,
      include: { user: { select: { name: true } }, campaignCreator: { select: { campaign: { select: { name: true } } } } },
    }),
    sentSince(dayStart),
    sentSince(weekStart),
  ]);

  const total = queues.reduce((sum, queue) => sum + queue.count, 0);
  // Messages logged per person: today and since Monday. The team's own daily count, without a sheet.
  const senders = await db.user.findMany({
    where: { id: { in: [...new Set(sentThisWeek.map((row) => row.userId))] } },
    select: { id: true, name: true },
  });
  const todayBy = new Map(sentToday.map((row) => [row.userId, row._count._all]));
  const outreach = senders
    .map((person) => ({
      name: person.name,
      today: todayBy.get(person.id) ?? 0,
      week: sentThisWeek.find((row) => row.userId === person.id)?._count._all ?? 0,
    }))
    .sort((a, b) => b.week - a.week);
  const byStatus = new Map(groups.map((group) => [group.status, group._count._all]));
  const sum = (statuses: CreatorStatus[]) => statuses.reduce((count, status) => count + (byStatus.get(status) ?? 0), 0);
  // The record that used to live in the spreadsheet, in one line.
  const figures = [
    { value: sum(["address_collected", "product_shipped"]), label: "gifts on the way" },
    { value: sum(["content_expected"]), label: "waiting for content" },
    { value: sum(["content_posted", "completed"]), label: "posted" },
    { value: sum(["no_content"]), label: "took a gift, never posted" },
  ].filter((figure) => figure.value > 0);

  return (
    <>
      <header className="mb-8 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div>
          <p className="eyebrow">
            {todayWords(now)}
            {view.brandId ? ` · ${brandName(view.brandId)}` : " · Both brands"}
          </p>
          <h1 className="mt-1.5">
            Good {timeOfDay(now)}, {firstName(user.name)}. {thingsNeedYou(total)}
          </h1>
          {figures.length > 0 ? (
            <p className="mt-3 text-muted-foreground">
              {figures.map((figure, index) => (
                <span key={figure.label}>
                  {index > 0 ? <span className="mx-2">·</span> : null}
                  <span className="stat-number text-[22px]">{figure.value}</span> {figure.label}
                </span>
              ))}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild variant="action">
            <Link href="/influencers/new">Check a profile</Link>
          </Button>
        </div>
      </header>

      <Panel plain title="Messages sent" className="mb-12">
        {outreach.length === 0 ? (
          <p className="pt-3 text-muted-foreground">No messages logged since Monday. Each one logged with the Message button counts here.</p>
        ) : (
          <ul className="grid gap-x-8 gap-y-1 pt-3 sm:grid-cols-2 lg:grid-cols-3">
            {outreach.map((person) => (
              <li key={person.name} className="flex items-baseline justify-between gap-3 border-b py-1.5 text-sm">
                <span>{person.name}</span>
                <span className="text-muted-foreground tabular-nums">
                  <span className="text-foreground">{person.today}</span> today · <span className="text-foreground">{person.week}</span> this week
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        plain
        title="What's next"
        aside={
          <span className="flex items-center gap-3 text-xs text-muted-foreground">
            {lastRun ? `Checked ${formatDateTime(lastRun.startedAt)}` : "Not checked yet"}
            <RunAutomationsButton />
          </span>
        }
      >
        <MessageComposer templates={templates} senderName={user.name}>
          <Table>
            <TableHeader className="sr-only">
              <TableRow>
                <TableHead>Creator</TableHead>
                <TableHead>Where they are</TableHead>
                <TableHead>Waiting</TableHead>
                <TableHead>Next</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {total === 0 ? (
                <EmptyRow colSpan={4}>All quiet. New replies, parcels and content dates show up here as they come due.</EmptyRow>
              ) : (
                queues
                  .filter((queue) => queue.count > 0)
                  .map((queue) => (
                    <GroupRows key={queue.key} queue={queue} now={now} />
                  ))
              )}
            </TableBody>
          </Table>
        </MessageComposer>
      </Panel>

      {activities.length > 0 ? (
        <Panel plain title="Recently" className="mt-12">
          <ActivityList items={activities} className="[&>li]:px-0" />
        </Panel>
      ) : null}
    </>
  );
}

type Queue = (typeof QUEUES)[number] & {
  count: number;
  items: {
    id: string;
    status: CreatorStatus;
    nextAction: string | null;
    nextActionDueAt: Date | null;
    campaign: { id: string; name: string };
    influencer: { id: string; name: string; profiles: { id: string; platform: "instagram" | "tiktok" | "youtube"; handle: string }[] };
  }[];
};

function GroupRows({ queue, now }: { queue: Queue; now: Date }) {
  return (
    <>
      <tr>
        <th colSpan={4} scope="rowgroup" className="pt-7 pb-2 text-left first:pt-2">
          <span className="font-heading text-[17px] font-medium">{queue.title}</span>
          <span className="ml-2 text-xs text-muted-foreground tabular-nums">{queue.count}</span>
        </th>
      </tr>
      {queue.items.map((item) => {
        const handle = item.influencer.profiles[0];
        return (
          <TableRow key={item.id}>
            <TableCell className="w-[34%]">
              <div className="flex items-center gap-2.5">
                <Avatar name={item.influencer.name} />
                <div className="min-w-0">
                  <Link href={`/influencers/${item.influencer.id}`} className="font-medium text-foreground hover:text-primary-text">
                    {item.influencer.name}
                  </Link>
                  <div className="truncate text-xs text-muted-foreground">
                    {handle ? displayHandle(handle.handle) : item.campaign.name}
                  </div>
                </div>
              </div>
            </TableCell>
            <TableCell>
              <CreatorStatusPill status={item.status} />
            </TableCell>
            <TableCell className="text-muted-foreground tabular-nums" title={item.nextActionDueAt ? `Since ${formatDay(item.nextActionDueAt)}` : undefined}>
              {waited(item.nextActionDueAt, now)}
            </TableCell>
            <TableCell className="text-right">
              <span className="mr-3 text-muted-foreground">{item.nextAction ?? "Needs attention"}</span>
              {queue.message ? (
                <MessageButton
                  target={{
                    campaignCreatorId: item.id,
                    influencerName: item.influencer.name,
                    status: item.status,
                    profiles: item.influencer.profiles,
                    blockedReason: SEND_BLOCKED_STATUSES.has(item.status) ? "Do not contact." : null,
                  }}
                />
              ) : (
                <Button asChild size="xs" variant="outline">
                  <Link href={`/influencers/${item.influencer.id}`}>Open</Link>
                </Button>
              )}
            </TableCell>
          </TableRow>
        );
      })}
      {queue.count > queue.items.length ? (
        <tr>
          <td colSpan={4} className="px-2.5 py-2 text-xs text-muted-foreground">
            Showing the {queue.items.length} who have waited longest of {queue.count}.
          </td>
        </tr>
      ) : null}
    </>
  );
}
