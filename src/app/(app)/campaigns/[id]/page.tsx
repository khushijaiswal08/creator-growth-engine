import type { CreatorStatus, Prisma } from "@prisma/client";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cn } from "cn";
import { Avatar } from "@/components/avatar";
import { DiscoveryPanel } from "@/components/discovery-panel";
import { AutomationSettingsForm } from "@/components/journey-forms";
import { MessageButton, MessageComposer } from "@/components/message-button";
import { EmptyRow, PageHeader, Panel } from "@/components/panel";
import { ProfileLinks } from "@/components/profile-links";
import { ScoringButton } from "@/components/scoring-button";
import { CampaignStatusPill } from "@/components/status-pill";
import { StatusSelect } from "@/components/status-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { allowed } from "@/lib/brand-scope";
import { brandName } from "@/lib/brands";
import { db } from "@/lib/db";
import { RUN_STATUS_LABELS, SOURCE_LABELS } from "@/lib/discovery";
import { formatCalendarDay, formatDateTime, formatDay } from "@/lib/format";
import { OFFER_STATUS_WHERE } from "@/lib/product-list";
import { requireUser } from "@/lib/session";
import {
  CREATOR_STATUS_LABELS,
  CREATOR_STATUS_TONES,
  CREATOR_STATUSES,
  parseCreatorStatus,
  SEND_BLOCKED_STATUSES,
  TONE_DOT,
  type StatusTone,
} from "@/lib/status";
import { loadSuppressions } from "@/lib/suppression";

export const metadata: Metadata = { title: "Campaign" };

const PAGE_SIZE = 100;

// Discovery calls outside APIs from a Server Action on this page.
export const maxDuration = 300;

export default async function CampaignPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ status?: string; q?: string; page?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const query = await searchParams;
  const filter = parseCreatorStatus(query.status ?? "");
  const q = (query.q ?? "").trim();
  const page = Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1);

  // Another brand's campaign is "not found" for someone tied to one brand, exactly like one that does not exist.
  const campaign = await db.campaign.findFirst({ where: { id, ...allowed(user).campaigns } });
  if (!campaign) notFound();

  const where: Prisma.CampaignCreatorWhereInput = {
    campaignId: id,
    ...(filter ? { status: filter } : {}),
    ...(q
      ? {
          influencer: {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
              { location: { contains: q, mode: "insensitive" } },
              { profiles: { some: { handle: { contains: q.replace(/^@/, "").toLowerCase() } } } },
            ],
          },
        }
      : {}),
  };

  const isAdmin = user.role === "admin";
  const now = new Date();

  const [creators, matching, counts, templates, runs, unscored, articles] = await Promise.all([
    db.campaignCreator.findMany({
      where,
      orderBy: [{ influencer: { name: "asc" } }, { id: "asc" }],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        influencer: { include: { profiles: { orderBy: { platform: "asc" } } } },
        owner: { select: { name: true } },
      },
    }),
    db.campaignCreator.count({ where }),
    db.campaignCreator.groupBy({ by: ["status"], where: { campaignId: id }, _count: { _all: true } }),
    db.template.findMany({
      where: { archived: false },
      orderBy: { name: "asc" },
      select: { id: true, name: true, purpose: true, body: true },
    }),
    isAdmin
      ? db.discoveryRun.findMany({
          where: { campaignId: id },
          orderBy: { startedAt: "desc" },
          take: 5,
          include: { startedBy: { select: { name: true } } },
        })
      : [],
    isAdmin
      ? db.campaignCreator.count({ where: { campaignId: id, status: "discovered", assessments: { none: {} } } })
      : 0,
    isAdmin
      ? db.product.findMany({
          where: { ...OFFER_STATUS_WHERE.offered, brandId: campaign.brandId },
          distinct: ["title"],
          orderBy: { title: "asc" },
          select: { title: true },
        })
      : [],
  ]);

  const suppressions = await loadSuppressions(creators.map((creator) => creator.influencer));
  const countByStatus = new Map(counts.map((row) => [row.status, row._count._all]));
  const total = counts.reduce((sum, row) => sum + row._count._all, 0);
  const lastPage = Math.max(1, Math.ceil(matching / PAGE_SIZE));

  // Links keep the search text; changing the status filter goes back to page 1.
  const listHref = (status: CreatorStatus | null, target = 1, search = q) => {
    const next = new URLSearchParams();
    if (status) next.set("status", status);
    if (search) next.set("q", search);
    if (target > 1) next.set("page", String(target));
    const text = next.toString();
    return text ? `/campaigns/${id}?${text}` : `/campaigns/${id}`;
  };

  const filterLink = (label: string, count: number, href: string, active: boolean, tone: StatusTone = "neutral") => (
    <Link key={href} href={href} aria-current={active ? "true" : undefined} className="chip outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span aria-hidden className={cn("size-1.5 rounded-full", TONE_DOT[tone])} />
      {label} <span className="tabular-nums">{count}</span>
    </Link>
  );

  return (
    <>
      <PageHeader
        title={campaign.name}
        meta={
          <>
            <CampaignStatusPill status={campaign.status} />
            {" · "}
            {campaign.deadline ? `Deadline ${formatCalendarDay(campaign.deadline)} · ` : ""}
            {campaign.targetPosts !== null ? `Target ${campaign.targetPosts} posts · ` : ""}
            {brandName(campaign.brandId)}
          </>
        }
      >
        <Button asChild variant="outline">
          <a href={`/campaigns/${campaign.id}/export`}>Export CSV</a>
        </Button>
        <Button asChild variant="outline">
          <Link href={`/campaigns/${campaign.id}/review`}>
            Review queue ({(countByStatus.get("discovered") ?? 0) + (countByStatus.get("scored") ?? 0)})
          </Link>
        </Button>
        <Button asChild variant="action">
          <Link href={`/influencers/new?campaignId=${campaign.id}`}>Add creator</Link>
        </Button>
      </PageHeader>

      <div className="mb-8 grid gap-1.5">
          <p className="max-w-3xl whitespace-pre-line text-[15px]">{campaign.brief}</p>
          {campaign.nicheKeywords.length > 0 ? (
            <p className="text-muted-foreground">Niche: {campaign.nicheKeywords.join(", ")}</p>
          ) : null}
          {campaign.negativeKeywords.length > 0 ? (
            <p className="text-muted-foreground">Avoid: {campaign.negativeKeywords.join(", ")}</p>
          ) : null}
      </div>

      {isAdmin ? (
        <details className="disclosure mb-4">
          <summary>Discovery and scoring</summary>
        <Panel className="mt-3">
          <DiscoveryPanel campaignId={campaign.id} hasKeywords={campaign.nicheKeywords.length > 0} />
          <div className="border-t p-4">
            <ScoringButton campaignId={campaign.id} unscored={unscored} />
          </div>
          {runs.length > 0 ? (
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
          ) : null}
        </Panel>
        </details>
      ) : null}

      {isAdmin ? (
        <details className="disclosure mb-8">
          <summary>Automation settings and which products creators may choose</summary>
        <Panel className="mt-3">
          <AutomationSettingsForm
            campaignId={campaign.id}
            values={{
              followUpAfterDays: campaign.followUpAfterDays,
              maxFollowUps: campaign.maxFollowUps,
              closeAfterDays: campaign.closeAfterDays,
              selectionWaitDays: campaign.selectionWaitDays,
              deliveryWaitDays: campaign.deliveryWaitDays,
              contentReminderDays: campaign.contentReminderDays,
              contentDueDays: campaign.contentDueDays,
              noContentAfterDays: campaign.noContentAfterDays,
            }}
            articles={articles.map((product) => product.title)}
            chosenArticles={campaign.giftArticles}
          />
        </Panel>
        </details>
      ) : null}

      <Panel title="Creators">
        <nav aria-label="Filter by status" className="flex flex-wrap gap-1.5 border-b px-4 py-3">
          {filterLink("All", total, listHref(null), filter === null)}
          {CREATOR_STATUSES.filter((status) => countByStatus.has(status) || status === filter).map((status) =>
            filterLink(
              CREATOR_STATUS_LABELS[status],
              countByStatus.get(status) ?? 0,
              listHref(status),
              status === filter,
              CREATOR_STATUS_TONES[status],
            ),
          )}
        </nav>

        <form method="get" className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
          {filter ? <input type="hidden" name="status" value={filter} /> : null}
          <label htmlFor="q" className="sr-only">
            Search creators in this campaign
          </label>
          <Input
            id="q"
            name="q"
            type="search"
            defaultValue={q}
            placeholder="Search name, handle, email or location"
            className="h-8 max-w-sm"
          />
          <Button type="submit" size="sm" variant="outline">
            Search
          </Button>
          {q ? (
            <Link href={listHref(filter, 1, "")} className="link">
              Clear
            </Link>
          ) : null}
          <span className="ml-auto text-muted-foreground tabular-nums">
            {matching === 0
              ? "0 creators"
              : `${(page - 1) * PAGE_SIZE + 1}-${Math.min(page * PAGE_SIZE, matching)} of ${matching}`}
          </span>
        </form>

        <MessageComposer templates={templates} senderName={user.name}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Creator</TableHead>
                <TableHead>Profiles</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Last contacted</TableHead>
                <TableHead>Next action</TableHead>
                <TableHead className="text-right">Outreach</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {creators.length === 0 ? (
                <EmptyRow colSpan={7}>
                  {q
                    ? "No creators match that search."
                    : filter
                      ? `No creators with status ${CREATOR_STATUS_LABELS[filter]}.`
                      : "No creators in this campaign yet. Add one, or use CSV import."}
                </EmptyRow>
              ) : (
                creators.map((creator) => {
                  const { influencer } = creator;
                  const suppressed = suppressions.reasonFor(influencer);
                  const blockedReason = influencer.archived
                    ? "This influencer is archived."
                    : suppressed
                      ? `On the suppression list: ${suppressed}`
                      : SEND_BLOCKED_STATUSES.has(creator.status)
                        ? `Marked ${CREATOR_STATUS_LABELS[creator.status]}.`
                        : null;

                  return (
                    <TableRow key={creator.id}>
                      <TableCell>
                        <div className="flex items-center gap-2.5">
                          <Avatar name={influencer.name} />
                          <div className="min-w-0">
                            <Link href={`/influencers/${influencer.id}`} className="link">
                              {influencer.name}
                            </Link>
                            {influencer.location ? (
                              <div className="text-xs text-muted-foreground">{influencer.location}</div>
                            ) : null}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <ProfileLinks profiles={influencer.profiles} />
                      </TableCell>
                      <TableCell>
                        <StatusSelect
                          campaignCreatorId={creator.id}
                          status={creator.status}
                          label={`Status for ${influencer.name}`}
                        />
                      </TableCell>
                      <TableCell>{creator.owner?.name ?? <span className="text-muted-foreground">Unassigned</span>}</TableCell>
                      <TableCell>{formatDay(creator.lastContactedAt)}</TableCell>
                      <TableCell className="max-w-56 whitespace-normal">
                        {creator.nextAction ? (
                          <>
                            {creator.nextAction}
                            {creator.nextActionDueAt ? (
                              <div className={cn("text-xs", creator.nextActionDueAt <= now ? "font-medium text-primary-text" : "text-muted-foreground")}>
                                {creator.nextActionDueAt <= now ? "due since " : "from "}
                                {formatDay(creator.nextActionDueAt)}
                              </div>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-muted-foreground">None</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <MessageButton
                          target={{
                            campaignCreatorId: creator.id,
                            influencerName: influencer.name,
                            status: creator.status,
                            profiles: influencer.profiles.map(({ id, platform, handle }) => ({ id, platform, handle })),
                            blockedReason,
                          }}
                        />
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
            <span className="text-muted-foreground">
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
      </Panel>
    </>
  );
}
