import type { CreatorStatus, Platform, Prisma } from "@prisma/client";
import { cn } from "cn";
import { Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionMenu, MENU_ITEM_CLASS } from "@/components/action-menu";
import { Avatar } from "@/components/avatar";
import { BoardFilter, type BoardFilters } from "@/components/board-filter";
import { DiscoveryPanel } from "@/components/discovery-panel";
import { AutomationSettingsForm } from "@/components/journey-forms";
import { MessageButton, MessageComposer } from "@/components/message-button";
import { EmptyRow } from "@/components/panel";
import { PipelineBoard, type BoardCard } from "@/components/pipeline-board";
import { isWarmth } from "@/lib/reply-reader";
import { ProfileLinks } from "@/components/profile-links";
import { ScoringButton } from "@/components/scoring-button";
import { CampaignStatusPill, CreatorStatusPill } from "@/components/status-pill";
import { StatusSelect } from "@/components/status-select";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { allowed } from "@/lib/brand-scope";
import { brandName } from "@/lib/brands";
import { db } from "@/lib/db";
import { RUN_STATUS_LABELS, SOURCE_LABELS } from "@/lib/discovery";
import { formatCalendarDay, formatDateTime, formatDay } from "@/lib/format";
import { suggestedTemplate } from "@/lib/next-action";
import { CLOSED_STATUSES, LANES } from "@/lib/pipeline";
import { OFFER_STATUS_WHERE } from "@/lib/product-list";
import { requireUser } from "@/lib/session";
import { CREATOR_STATUS_LABELS, CREATOR_STATUSES, parseCreatorStatus, SEND_BLOCKED_STATUSES } from "@/lib/status";
import { loadSuppressions } from "@/lib/suppression";

export const metadata: Metadata = { title: "Campaign" };

const PAGE_SIZE = 100;
const VIEWS = ["board", "list", "discovery", "settings"] as const;
type View = (typeof VIEWS)[number];
const PLATFORMS: Platform[] = ["instagram", "youtube", "tiktok"];

// Discovery calls outside APIs from a Server Action on this page.
export const maxDuration = 300;

type Query = { view?: string; status?: string; q?: string; page?: string; mine?: string; owner?: string; platform?: string; followers?: string };

export default async function CampaignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Query> }) {
  const user = await requireUser();
  const { id } = await params;
  const query = await searchParams;
  const isAdmin = user.role === "admin";
  const filter = parseCreatorStatus(query.status ?? "");
  const q = (query.q ?? "").trim();
  const mine = query.mine === "1";
  const filters: BoardFilters = {
    owner: query.owner ?? "",
    platform: PLATFORMS.includes(query.platform as Platform) ? (query.platform as Platform) : "",
    followers: /^\d+$/.test(query.followers ?? "") ? query.followers! : "",
  };
  const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);
  const requested = (VIEWS as readonly string[]).includes(query.view ?? "") ? (query.view as View) : filter ? "list" : "board";
  const view: View = (requested === "discovery" || requested === "settings") && !isAdmin ? "board" : requested;

  // Another brand's campaign is "not found" for someone tied to one brand, exactly like one that does not exist.
  const campaign = await db.campaign.findFirst({ where: { id, ...allowed(user).campaigns } });
  if (!campaign) notFound();

  // Everything the toolbar narrows: search, owner, platform, followers, "only mine".
  const influencerWhere: Prisma.InfluencerWhereInput = {
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { location: { contains: q, mode: "insensitive" } },
            { profiles: { some: { handle: { contains: q.replace(/^@/, "").toLowerCase() } } } },
          ],
        }
      : {}),
    ...(filters.platform || filters.followers
      ? { profiles: { some: { ...(filters.platform ? { platform: filters.platform as Platform } : {}), ...(filters.followers ? { followers: { gte: Number(filters.followers) } } : {}) } } }
      : {}),
  };
  const narrowed = Object.keys(influencerWhere).length > 0;
  const ownerId = mine ? user.id : filters.owner || null;
  const base: Prisma.CampaignCreatorWhereInput = { campaignId: id, ...(ownerId ? { ownerId } : {}), ...(narrowed ? { influencer: influencerWhere } : {}) };
  const now = new Date();

  const [counts, templates, owners] = await Promise.all([
    db.campaignCreator.groupBy({ by: ["status"], where: { campaignId: id }, _count: { _all: true } }),
    db.template.findMany({ where: { archived: false }, orderBy: { name: "asc" }, select: { id: true, name: true, purpose: true, body: true } }),
    db.user.findMany({ where: { isSystem: false, ownedCreators: { some: { campaignId: id } } }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  const countByStatus = new Map(counts.map((row) => [row.status, row._count._all]));
  const total = counts.reduce((sum, row) => sum + row._count._all, 0);
  const toReview = (countByStatus.get("discovered") ?? 0) + (countByStatus.get("scored") ?? 0);

  const tabHref = (target: View) => (target === "board" ? `/campaigns/${id}` : `/campaigns/${id}?view=${target}`);
  const keep = new URLSearchParams();
  if (q) keep.set("q", q);
  if (mine) keep.set("mine", "1");
  if (filters.owner) keep.set("owner", filters.owner);
  if (filters.platform) keep.set("platform", filters.platform);
  if (filters.followers) keep.set("followers", filters.followers);

  return (
    <>
      <p className="eyebrow mb-2">
        <Link href="/campaigns" className="hover:text-foreground">
          Campaigns
        </Link>{" "}
        › {brandName(campaign.brandId)}
      </p>
      <header className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[26px]">{campaign.name}</h1>
            <CampaignStatusPill status={campaign.status} />
          </div>
          <p className="mt-0.5 line-clamp-1 text-muted-foreground" title={campaign.brief}>
            {campaign.brief}
            {campaign.deadline ? ` · Deadline ${formatCalendarDay(campaign.deadline)}` : ""}
            {campaign.targetPosts !== null ? ` · Target ${campaign.targetPosts} posts` : ""}
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button asChild variant="action">
            <Link href={`/influencers/new?campaignId=${campaign.id}`}>+ Add creator</Link>
          </Button>
          <ActionMenu>
            <a href={`/campaigns/${campaign.id}/export`} className={MENU_ITEM_CLASS}>
              Export CSV
            </a>
            <Link href={`/campaigns/${campaign.id}/review`} className={MENU_ITEM_CLASS}>
              Open the review queue
            </Link>
            {isAdmin ? (
              <Link href={tabHref("discovery")} className={MENU_ITEM_CLASS}>
                Run discovery or scoring
              </Link>
            ) : null}
          </ActionMenu>
        </div>
      </header>

      <nav id="campaign-tabs" aria-label="Campaign sections" className="tabs mb-5">
        <Link href={tabHref("board")} className="tab" aria-current={view === "board" ? "true" : undefined}>
          Board
        </Link>
        <Link href={tabHref("list")} className="tab" aria-current={view === "list" ? "true" : undefined}>
          List
        </Link>
        <Link href={`/campaigns/${campaign.id}/review`} className="tab">
          Review queue <span className={cn("chip border-transparent px-1.5 py-0 text-[11px]", toReview > 0 ? "bg-warning-soft text-warning-text" : "bg-surface-2")}>{toReview}</span>
        </Link>
        {isAdmin ? (
          <Link href={tabHref("discovery")} className="tab" aria-current={view === "discovery" ? "true" : undefined}>
            Discovery and scoring
          </Link>
        ) : null}
        {isAdmin ? (
          <Link href={tabHref("settings")} className="tab" aria-current={view === "settings" ? "true" : undefined}>
            Settings
          </Link>
        ) : null}
      </nav>

      {view === "board" || view === "list" ? (
        <div id="board-toolbar" className="mb-4 flex flex-wrap items-center gap-2">
          <form method="get" className="relative">
            {view === "list" ? <input type="hidden" name="view" value="list" /> : null}
            {filter ? <input type="hidden" name="status" value={filter} /> : null}
            {mine ? <input type="hidden" name="mine" value="1" /> : null}
            {filters.owner ? <input type="hidden" name="owner" value={filters.owner} /> : null}
            {filters.platform ? <input type="hidden" name="platform" value={filters.platform} /> : null}
            {filters.followers ? <input type="hidden" name="followers" value={filters.followers} /> : null}
            <label htmlFor="q" className="sr-only">
              Search creators in this campaign
            </label>
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" strokeWidth={2} />
            <input id="q" name="q" type="search" defaultValue={q} placeholder="Search creators" className="h-9 w-72 rounded-md border border-border-strong bg-surface pr-3 pl-9 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring max-md:h-11" />
          </form>
          <BoardFilter owners={owners} values={filters} view={view} q={q} mine={mine} />
          <form method="get">
            {view === "list" ? <input type="hidden" name="view" value="list" /> : null}
            {filter ? <input type="hidden" name="status" value={filter} /> : null}
            {q ? <input type="hidden" name="q" value={q} /> : null}
            {filters.owner ? <input type="hidden" name="owner" value={filters.owner} /> : null}
            {filters.platform ? <input type="hidden" name="platform" value={filters.platform} /> : null}
            {filters.followers ? <input type="hidden" name="followers" value={filters.followers} /> : null}
            {mine ? null : <input type="hidden" name="mine" value="1" />}
            <button type="submit" className={cn("inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-semibold max-md:h-11", mine ? "border-primary bg-primary-soft text-primary-text" : "border-border-strong bg-surface hover:bg-surface-2")}>
              <span aria-hidden className={cn("flex size-4 items-center justify-center rounded border text-[10px]", mine ? "border-primary bg-primary text-on-primary" : "border-border-strong bg-surface")}>
                {mine ? "✓" : ""}
              </span>
              Only mine
            </button>
          </form>
          {q || mine || filters.owner || filters.platform || filters.followers ? (
            <Link href={tabHref(view)} className="link text-sm">
              Clear
            </Link>
          ) : null}
          <span className="ml-auto text-xs text-muted-foreground">
            {total} {total === 1 ? "creator" : "creators"}
            {view === "board" ? <DueCount campaignId={id} base={base} now={now} /> : null}
          </span>
        </div>
      ) : null}

      {view === "board" ? <BoardView campaignId={id} base={base} influencer={influencerWhere} keep={keep} templates={templates} senderName={user.name} now={now} /> : null}
      {view === "list" ? <ListView campaignId={id} base={base} keep={keep} filter={filter} page={page} countByStatus={countByStatus} total={total} templates={templates} senderName={user.name} now={now} /> : null}
      {view === "discovery" && isAdmin ? <DiscoveryView campaign={campaign} /> : null}
      {view === "settings" && isAdmin ? <SettingsView campaign={campaign} /> : null}
    </>
  );
}

type Templates = { id: string; name: string; purpose: "first" | "followup" | "agreed" | "other" | "selection" | "reminder" | "delivered" | "arrival" | "deadline"; body: string }[];

/** " · 3 need you today", for the right of the toolbar. */
async function DueCount({ base, now }: { campaignId: string; base: Prisma.CampaignCreatorWhereInput; now: Date }) {
  const due = await db.campaignCreator.count({ where: { ...base, status: { notIn: CLOSED_STATUSES }, nextActionDueAt: { lte: now }, waitingOn: { not: "creator" } } });
  return due > 0 ? ` · ${due} need you today` : "";
}

async function BoardView({
  campaignId,
  base,
  influencer,
  keep,
  templates,
  senderName,
  now,
}: {
  campaignId: string;
  base: Prisma.CampaignCreatorWhereInput;
  influencer: Prisma.InfluencerWhereInput;
  keep: URLSearchParams;
  templates: Templates;
  senderName: string;
  now: Date;
}) {
  const doneStatuses: CreatorStatus[] = [...LANES[LANES.length - 1].statuses, ...CLOSED_STATUSES];
  const [rows, done] = await Promise.all([
    db.campaignCreator.findMany({
      where: { ...base, status: { notIn: doneStatuses }, influencer: { ...influencer, archived: false } },
      orderBy: [{ nextActionDueAt: "asc" }, { influencer: { name: "asc" } }],
      select: {
        id: true,
        status: true,
        nextAction: true,
        nextActionDueAt: true,
        waitingOn: true,
        fitScore: true,
        replyWarmth: true,
        replyRead: true,
        influencer: { select: { id: true, name: true, email: true, amazonTier: true, profiles: { select: { id: true, platform: true, handle: true, followers: true }, orderBy: { platform: "asc" } } } },
      },
    }),
    db.campaignCreator.groupBy({ by: ["status"], where: { ...base, status: { in: doneStatuses } }, _count: { _all: true } }),
  ]);
  const suppressions = await loadSuppressions(rows.map((row) => row.influencer));
  const cards: BoardCard[] = rows.map((row) => {
    const suppressed = suppressions.reasonFor(row.influencer);
    const first = row.influencer.profiles[0];
    return {
      id: row.id,
      influencerId: row.influencer.id,
      name: row.influencer.name,
      handle: first ? `@${first.handle}` : null,
      followers: first?.followers ?? null,
      status: row.status,
      nextAction: row.nextAction,
      dueAt: row.nextActionDueAt,
      waitingOn: row.waitingOn,
      fitScore: row.fitScore,
      warmth: isWarmth(row.replyWarmth) ? row.replyWarmth : null,
      readSummary: row.replyRead,
      profiles: row.influencer.profiles.map(({ id, platform, handle }) => ({ id, platform, handle })),
      email: row.influencer.email,
      amazonCreator: row.influencer.amazonTier !== null,
      blockedReason: suppressed ? `On the do-not-contact list: ${suppressed}` : SEND_BLOCKED_STATUSES.has(row.status) ? `Marked ${CREATOR_STATUS_LABELS[row.status]}.` : null,
      purpose: suggestedTemplate(row.status, row.nextAction),
    };
  });
  // Posted and completed first, then the closed outcomes by size.
  const doneRows = done.map((row) => ({ status: row.status, count: row._count._all })).sort((a, b) => Number(CLOSED_STATUSES.includes(a.status)) - Number(CLOSED_STATUSES.includes(b.status)) || b.count - a.count);
  const list = new URLSearchParams(keep);
  list.set("view", "list");

  return (
    <MessageComposer templates={templates} senderName={senderName}>
      <PipelineBoard cards={cards} done={doneRows} reviewHref={`/campaigns/${campaignId}/review`} listHref={`/campaigns/${campaignId}?${list}`} now={now} />
    </MessageComposer>
  );
}

async function ListView({
  campaignId,
  base,
  keep,
  filter,
  page,
  countByStatus,
  total,
  templates,
  senderName,
  now,
}: {
  campaignId: string;
  base: Prisma.CampaignCreatorWhereInput;
  keep: URLSearchParams;
  filter: CreatorStatus | null;
  page: number;
  countByStatus: Map<CreatorStatus, number>;
  total: number;
  templates: Templates;
  senderName: string;
  now: Date;
}) {
  const where: Prisma.CampaignCreatorWhereInput = { ...base, ...(filter ? { status: filter } : {}) };
  const [creators, matching] = await Promise.all([
    db.campaignCreator.findMany({
      where,
      orderBy: [{ influencer: { name: "asc" } }, { id: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { influencer: { include: { profiles: { orderBy: { platform: "asc" } } } }, owner: { select: { name: true } } },
    }),
    db.campaignCreator.count({ where }),
  ]);
  const suppressions = await loadSuppressions(creators.map((creator) => creator.influencer));
  const lastPage = Math.max(1, Math.ceil(matching / PAGE_SIZE));

  // Links keep the search and filters; changing the status goes back to page 1.
  const listHref = (status: CreatorStatus | null, target = 1) => {
    const next = new URLSearchParams(keep);
    next.set("view", "list");
    if (status) next.set("status", status);
    if (target > 1) next.set("page", String(target));
    return `/campaigns/${campaignId}?${next}`;
  };

  return (
    <section className="card overflow-hidden">
      <nav aria-label="Filter by status" className="flex flex-wrap gap-1.5 border-b px-4 py-3">
        <Link href={listHref(null)} aria-current={filter === null ? "true" : undefined} className="chip">
          All <span className="tabular-nums">{total}</span>
        </Link>
        {CREATOR_STATUSES.filter((status) => countByStatus.has(status) || status === filter).map((status) => (
          <Link key={status} href={listHref(status)} aria-current={status === filter ? "true" : undefined} className="chip">
            {CREATOR_STATUS_LABELS[status]} <span className="tabular-nums">{countByStatus.get(status) ?? 0}</span>
          </Link>
        ))}
        <span className="ml-auto self-center text-xs text-muted-foreground tabular-nums">{matching === 0 ? "0 creators" : `${(page - 1) * PAGE_SIZE + 1}-${Math.min(page * PAGE_SIZE, matching)} of ${matching}`}</span>
      </nav>

      <MessageComposer templates={templates} senderName={senderName}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Creator</TableHead>
              <TableHead>Profiles</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Last contacted</TableHead>
              <TableHead>Next step</TableHead>
              <TableHead className="text-right">Move / message</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {creators.length === 0 ? (
              <EmptyRow colSpan={7}>{filter ? `No creators with status ${CREATOR_STATUS_LABELS[filter]}.` : "No creators match. Clear the search or the filters, or add one."}</EmptyRow>
            ) : (
              creators.map((creator) => {
                const { influencer } = creator;
                const suppressed = suppressions.reasonFor(influencer);
                const blockedReason = influencer.archived ? "This creator is archived." : suppressed ? `On the do-not-contact list: ${suppressed}` : SEND_BLOCKED_STATUSES.has(creator.status) ? `Marked ${CREATOR_STATUS_LABELS[creator.status]}.` : null;
                const late = Boolean(creator.nextActionDueAt && creator.nextActionDueAt <= now && creator.waitingOn !== "creator");
                return (
                  <TableRow key={creator.id}>
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <Avatar name={influencer.name} />
                        <div className="min-w-0">
                          <Link href={`/influencers/${influencer.id}`} className="font-semibold hover:text-primary-text">
                            {influencer.name}
                          </Link>
                          {influencer.location ? <div className="text-xs text-muted-foreground">{influencer.location}</div> : null}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <ProfileLinks profiles={influencer.profiles} />
                    </TableCell>
                    <TableCell>
                      <CreatorStatusPill status={creator.status} />
                    </TableCell>
                    <TableCell>{creator.owner?.name ?? <span className="text-muted-foreground">Unassigned</span>}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDay(creator.lastContactedAt) || "–"}</TableCell>
                    <TableCell className="max-w-56 whitespace-normal">
                      {creator.nextAction ? (
                        <>
                          {creator.nextAction}
                          {creator.nextActionDueAt ? (
                            <div className={cn("text-xs", late ? "font-semibold text-danger-text" : "text-muted-foreground")}>
                              {late ? "due since " : "from "}
                              {formatDay(creator.nextActionDueAt)}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <StatusSelect campaignCreatorId={creator.id} status={creator.status} label={`Status for ${influencer.name}`} />
                        <MessageButton
                          target={{
                            campaignCreatorId: creator.id,
                            influencerName: influencer.name,
                            status: creator.status,
                            profiles: influencer.profiles.map(({ id, platform, handle }) => ({ id, platform, handle })),
                            email: influencer.email,
                            amazonCreator: influencer.amazonTier !== null,
                            blockedReason,
                            purpose: suggestedTemplate(creator.status, creator.nextAction),
                          }}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </MessageComposer>

      {lastPage > 1 ? (
        <div className="flex items-center justify-between border-t px-4 py-2.5">
          <span className="text-sm text-muted-foreground">
            Page {Math.min(page, lastPage)} of {lastPage}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Button asChild size="sm" variant="outline">
                <Link href={listHref(filter, Math.min(page - 1, lastPage))}>Previous</Link>
              </Button>
            ) : null}
            {page < lastPage ? (
              <Button asChild size="sm" variant="outline">
                <Link href={listHref(filter, page + 1)}>Next</Link>
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  );
}

async function DiscoveryView({ campaign }: { campaign: { id: string; nicheKeywords: string[]; negativeKeywords: string[] } }) {
  const [runs, unscored] = await Promise.all([
    db.discoveryRun.findMany({ where: { campaignId: campaign.id }, orderBy: { startedAt: "desc" }, take: 8, include: { startedBy: { select: { name: true } } } }),
    db.campaignCreator.count({ where: { campaignId: campaign.id, status: "discovered", assessments: { none: {} } } }),
  ]);
  return (
    <div className="grid gap-5">
      <section className="card overflow-hidden">
        <div className="border-b px-4 py-3">
          <h2>Find and score creators</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Searches by the campaign&apos;s keywords{campaign.nicheKeywords.length > 0 ? `: ${campaign.nicheKeywords.join(", ")}` : " (none set yet)"}
            {campaign.negativeKeywords.length > 0 ? `; avoiding ${campaign.negativeKeywords.join(", ")}` : ""}.
          </p>
        </div>
        <DiscoveryPanel campaignId={campaign.id} hasKeywords={campaign.nicheKeywords.length > 0} />
        <div className="border-t p-4">
          <ScoringButton campaignId={campaign.id} unscored={unscored} />
        </div>
      </section>
      {runs.length > 0 ? (
        <section className="card overflow-hidden">
          <div className="border-b px-4 py-3">
            <h2>Recent runs</h2>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="text-right">Found</TableHead>
                <TableHead className="text-right">New</TableHead>
                <TableHead className="text-right">Known</TableHead>
                <TableHead className="text-right">Skipped</TableHead>
                <TableHead className="text-right">Quota</TableHead>
                <TableHead>Note</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>
                    {formatDateTime(run.startedAt)}
                    <div className="text-xs text-muted-foreground">{run.startedBy.name}</div>
                  </TableCell>
                  <TableCell>{SOURCE_LABELS[run.source]}</TableCell>
                  <TableCell>{RUN_STATUS_LABELS[run.status]}</TableCell>
                  <TableCell className="text-right tabular-nums">{run.found}</TableCell>
                  <TableCell className="text-right tabular-nums">{run.added}</TableCell>
                  <TableCell className="text-right tabular-nums">{run.alreadyKnown}</TableCell>
                  <TableCell className="text-right tabular-nums">{run.skipped}</TableCell>
                  <TableCell className="text-right tabular-nums">{run.quotaUsed}</TableCell>
                  <TableCell className="max-w-md whitespace-normal text-muted-foreground">{run.note}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : null}
    </div>
  );
}

async function SettingsView({
  campaign,
}: {
  campaign: {
    id: string;
    brandId: string;
    brief: string;
    nicheKeywords: string[];
    negativeKeywords: string[];
    giftArticles: string[];
    followUpAfterDays: number;
    maxFollowUps: number;
    closeAfterDays: number;
    arrivalCheckDays: number;
    selectionWaitDays: number;
    deliveryWaitDays: number;
    contentReminderDays: number;
    contentDueDays: number;
    noContentAfterDays: number;
  };
}) {
  const articles = await db.product.findMany({ where: { ...OFFER_STATUS_WHERE.offered, brandId: campaign.brandId }, distinct: ["title"], orderBy: { title: "asc" }, select: { title: true } });
  return (
    <div className="grid gap-5">
      <section className="card p-5">
        <h2>Brief and keywords</h2>
        <p className="mt-2 max-w-3xl text-sm whitespace-pre-line">{campaign.brief}</p>
        <dl className="mt-3 grid gap-1 text-sm">
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Niche:</dt>
            <dd>{campaign.nicheKeywords.length > 0 ? campaign.nicheKeywords.join(", ") : "none yet"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted-foreground">Avoid:</dt>
            <dd>{campaign.negativeKeywords.length > 0 ? campaign.negativeKeywords.join(", ") : "none"}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">The brief and keywords are set when a campaign is created; ask an admin to change them.</p>
      </section>
      <section className="card overflow-hidden">
        <div className="border-b px-4 py-3">
          <h2>Timers and which products creators may choose</h2>
        </div>
        <AutomationSettingsForm
          campaignId={campaign.id}
          values={{
            followUpAfterDays: campaign.followUpAfterDays,
            maxFollowUps: campaign.maxFollowUps,
            closeAfterDays: campaign.closeAfterDays,
            arrivalCheckDays: campaign.arrivalCheckDays,
            selectionWaitDays: campaign.selectionWaitDays,
            deliveryWaitDays: campaign.deliveryWaitDays,
            contentReminderDays: campaign.contentReminderDays,
            contentDueDays: campaign.contentDueDays,
            noContentAfterDays: campaign.noContentAfterDays,
          }}
          articles={articles.map((product) => product.title)}
          chosenArticles={campaign.giftArticles}
        />
      </section>
    </div>
  );
}
