import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { NativeSelect } from "@/components/native-select";
import { PageHeader, Panel } from "@/components/panel";
import { ReviewQueue, type ReviewCard } from "@/components/review-queue";
import { ScoringButton } from "@/components/scoring-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { allowed } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import { SOURCE_LABELS } from "@/lib/discovery";
import { formatCount, formatDay } from "@/lib/format";
import { PLATFORM_LABELS, PLATFORMS } from "@/lib/profile-url";
import {
  findPossibleDuplicates,
  loadReviewQueue,
  parseReviewFilters,
  reviewFilterQuery,
  US_SIGNAL_LABELS,
  US_SIGNALS,
} from "@/lib/review-queue";
import { requireUser } from "@/lib/session";
import { describeTrackRecord, trackRecordFor } from "@/lib/track-record";

export const metadata: Metadata = { title: "Review queue" };

// AI scoring runs from a Server Action on this page.
export const maxDuration = 300;

const CARDS_PER_PAGE = 30;
const FILTER_SOURCES = ["youtube", "meta_free", "csv", "manual"] as const;

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const filters = parseReviewFilters(await searchParams);

  const scope = allowed(user);
  const campaign = await db.campaign.findFirst({ where: { id, ...scope.campaigns }, select: { id: true, name: true } });
  if (!campaign) notFound();

  const [items, unscored] = await Promise.all([
    loadReviewQueue(id, filters),
    user.role === "admin"
      ? db.campaignCreator.count({ where: { campaignId: id, status: "discovered", assessments: { none: {} } } })
      : 0,
  ]);
  const shown = items.slice(0, CARDS_PER_PAGE);
  // Look-alikes are only looked for among creators this person may see.
  const [duplicates, records] = await Promise.all([
    findPossibleDuplicates(shown, scope.influencers),
    trackRecordFor(shown.map((item) => item.influencerId), scope),
  ]);

  const cards: ReviewCard[] = shown.map((item) => ({
    trackRecord: describeTrackRecord(records.get(item.influencerId)),
    campaignCreatorId: item.campaignCreatorId,
    influencerId: item.influencerId,
    name: item.name,
    location: item.location,
    priorityReview: item.priorityReview,
    score: item.score,
    lowFit: item.lowFit,
    usSignal: item.usSignal,
    emailStatus: item.emailStatus,
    reasons: item.reasons,
    profiles: item.profiles.map((profile) => ({ ...profile, followers: formatCount(profile.followers) })),
    latestPostUrl: item.latestPostUrl,
    latestPostDay: formatDay(item.latestPostAt),
    duplicates: duplicates.get(item.campaignCreatorId) ?? [],
  }));

  const query = reviewFilterQuery(filters);
  const filtered = query !== "";

  return (
    <>
      <PageHeader
        title="Review queue"
        meta={
          <>
            <Link href={`/campaigns/${campaign.id}`} className="link">
              {campaign.name}
            </Link>
            {`, ${items.length} waiting${filtered ? " with these filters" : ""}`}
            {items.length > cards.length ? `, showing the first ${cards.length}` : ""}
          </>
        }
      >
        <Button asChild variant="outline">
          <a href={`/campaigns/${campaign.id}/review/export${query ? `?${query}` : ""}`}>Export CSV</a>
        </Button>
      </PageHeader>

      {user.role === "admin" ? (
        <Panel className="mb-4">
          <div className="p-4">
            <ScoringButton campaignId={campaign.id} unscored={unscored} />
          </div>
        </Panel>
      ) : null}

      <Panel className="mb-4">
        <form method="get" className="flex flex-wrap items-end gap-3 p-4">
          <label className="grid gap-1 text-sm font-medium">
            Platform
            <NativeSelect name="platform" defaultValue={filters.platform ?? ""} className="h-8 w-36">
              <option value="">Any</option>
              {PLATFORMS.map((platform) => (
                <option key={platform} value={platform}>
                  {PLATFORM_LABELS[platform]}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Minimum score
            <Input name="minScore" type="number" min={0} max={100} step={1} defaultValue={filters.minScore ?? ""} className="h-8 w-28" />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Email
            <NativeSelect name="email" defaultValue={filters.email ?? ""} className="h-8 w-36">
              <option value="">Any</option>
              <option value="found">Found</option>
              <option value="not_found">Not found</option>
            </NativeSelect>
          </label>
          <label className="grid gap-1 text-sm font-medium">
            US signal
            <NativeSelect name="us" defaultValue={filters.us ?? ""} className="h-8 w-40">
              <option value="">Any</option>
              {US_SIGNALS.map((signal) => (
                <option key={signal} value={signal}>
                  {US_SIGNAL_LABELS[signal]}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="grid gap-1 text-sm font-medium">
            Source
            <NativeSelect name="source" defaultValue={filters.source ?? ""} className="h-8 w-56">
              <option value="">Any</option>
              {FILTER_SOURCES.map((source) => (
                <option key={source} value={source}>
                  {SOURCE_LABELS[source]}
                </option>
              ))}
            </NativeSelect>
          </label>
          <Button type="submit" size="sm" variant="outline">
            Apply filters
          </Button>
          {filtered ? (
            <Link href={`/campaigns/${campaign.id}/review`} className="pb-1.5 link">
              Clear
            </Link>
          ) : null}
          <p className="ml-auto pb-1.5 text-muted-foreground">
            Keys: <kbd className="font-semibold">A</kbd> approve, <kbd className="font-semibold">R</kbd> reject,{" "}
            <kbd className="font-semibold">L</kbd> review later
          </p>
        </form>
      </Panel>

      <ReviewQueue cards={cards} />
    </>
  );
}
