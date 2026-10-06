import { allowed } from "@/lib/brand-scope";
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

/** Quotes a cell, and defuses values a spreadsheet would run as a formula. */
function cell(value: string | number | boolean | null): string {
  let text = value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

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
      lines.push(COLUMNS.map((column) => cell(row[column])).join(","));
    }
  }

  const fileName = `review-queue-${campaign.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.csv`;
  // The BOM makes Excel read the file as UTF-8.
  return new Response(`﻿${lines.join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}
