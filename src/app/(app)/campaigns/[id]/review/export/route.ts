import { allowed } from "@/lib/brand-scope";
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

  const lines = [COLUMNS.join(",")];
  for (const item of items) {
    for (const profile of item.profiles) {
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
        reasons: item.reasons.join(" | "),
      };
      lines.push(csvLine(COLUMNS.map((column) => row[column])));
    }
  }

  return csvResponse(lines, `review-queue-${fileSlug(campaign.name)}.csv`);
}
