import { allowed } from "@/lib/brand-scope";
import { loadProfileInsights } from "@/lib/creator-insights-data";
import { csvLine, csvResponse, fileSlug } from "@/lib/csv-out";
import { db } from "@/lib/db";
import { SOURCE_LABELS } from "@/lib/discovery";
import { profileUrl } from "@/lib/profile-url";
import { loadReviewQueue, parseReviewFilters } from "@/lib/review-queue";
import { requireUser } from "@/lib/session";

const COLUMNS = [
  "name",
  "platform",
  "handle",
  "profile_url",
  "followers",
  "location",
  "email",
  "email_status",
  "us_signal",
  "score",
  "priority_review",
  "low_fit",
  "status",
  "source",
  "latest_post",
  "posts_7d",
  "posts_30d",
  "likes_30d",
  "comments_30d",
  "views_30d",
  "public_numbers_read_on",
  "creator_reach_7d",
  "creator_reach_30d",
  "creator_profile_views_30d",
  "creator_us_audience_pct",
  "creator_numbers_as_of",
  "reasons",
] as const;

/** The review queue with the current filters, one row per profile. Signed-in users only. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  const campaign = await db.campaign.findFirst({ where: { id, ...allowed(user).campaigns }, select: { name: true } });
  if (!campaign) return new Response("Campaign not found", { status: 404 });

  const filters = parseReviewFilters(Object.fromEntries(new URL(request.url).searchParams));
  const items = await loadReviewQueue(id, filters);
  const insights = await loadProfileInsights(items.flatMap((item) => item.profiles.map(({ id: profileId, platform }) => ({ id: profileId, platform }))), new Date());

  const lines = [COLUMNS.join(",")];
  for (const item of items) {
    for (const profile of item.profiles) {
      const found = insights.get(profile.id);
      const activity = found?.activity ?? null;
      const supplied = found?.supplied ?? null;
      const row: Record<(typeof COLUMNS)[number], string | number | boolean | null> = {
        name: item.name,
        platform: profile.platform,
        handle: profile.handle,
        profile_url: profileUrl(profile.platform, profile.handle),
        followers: profile.followers,
        location: item.location,
        email: item.email,
        email_status: item.emailStatus,
        us_signal: item.usSignal,
        score: item.score,
        priority_review: item.priorityReview,
        low_fit: item.lowFit,
        status: item.status,
        source: SOURCE_LABELS[profile.source],
        latest_post: item.latestPostUrl,
        posts_7d: activity?.days7.posts ?? null,
        posts_30d: activity?.days30.posts ?? null,
        likes_30d: activity?.days30.likes ?? null,
        comments_30d: activity?.days30.comments ?? null,
        views_30d: activity?.days30.views ?? null,
        public_numbers_read_on: activity ? activity.asOf.toISOString().slice(0, 10) : null,
        creator_reach_7d: supplied?.reach7d ?? null,
        creator_reach_30d: supplied?.reach30d ?? null,
        creator_profile_views_30d: supplied?.profileViews30d ?? null,
        creator_us_audience_pct: supplied?.usAudiencePct ?? null,
        creator_numbers_as_of: supplied ? supplied.asOf.toISOString().slice(0, 10) : null,
        reasons: item.reasons.join(" | "),
      };
      lines.push(csvLine(COLUMNS.map((column) => row[column])));
    }
  }

  return csvResponse(lines, `review-queue-${fileSlug(campaign.name)}.csv`);
}
