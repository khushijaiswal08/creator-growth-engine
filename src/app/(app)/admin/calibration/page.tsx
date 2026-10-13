import type { Metadata } from "next";
import Link from "next/link";
import { CalibrationCards, type CalibrationCard } from "@/components/calibration-cards";
import { PageHeader, Panel } from "@/components/panel";
import { BRANDS, isBrandId } from "@/lib/brands";
import { db } from "@/lib/db";
import { formatCount } from "@/lib/format";
import { displayHandle, profileUrl } from "@/lib/profile-url";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Scoring calibration" };

const SAMPLE = 30;
const THRESHOLDS = [50, 60, 75];

/**
 * Admin only. Thirty random scored creators of a brand beside the reviewer's
 * own yes or no, and how often the two agree at a few score thresholds.
 * Used with the team to tune the prompt in Settings.
 */
export default async function CalibrationPage({ searchParams }: { searchParams: Promise<{ brand?: string }> }) {
  await requireAdmin();
  const raw = (await searchParams).brand ?? "";
  const brandId = isBrandId(raw) ? raw : BRANDS[0].id;

  const ofBrand = { campaignCreator: { campaign: { brandId } } };
  // Latest assessment per creator; random order so the sample is not the same thirty every time.
  const [reviewed, unreviewedIds, totals] = await Promise.all([
    db.fitAssessment.findMany({ where: { ...ofBrand, reviewerVerdict: { not: null } }, select: { id: true, score: true, reviewerVerdict: true } }),
    db.$queryRaw<{ id: string }[]>`
      SELECT a.id FROM "FitAssessment" a
      JOIN "CampaignCreator" cc ON cc.id = a."campaignCreatorId"
      JOIN "Campaign" c ON c.id = cc."campaignId"
      WHERE c."brandId" = ${brandId} AND a."reviewerVerdict" IS NULL
        AND a."createdAt" = (SELECT MAX(b."createdAt") FROM "FitAssessment" b WHERE b."campaignCreatorId" = a."campaignCreatorId")
      ORDER BY random() LIMIT ${SAMPLE}`,
    db.fitAssessment.count({ where: ofBrand }),
  ]);

  const rows = await db.fitAssessment.findMany({
    where: { id: { in: unreviewedIds.map((row) => row.id) } },
    include: { campaignCreator: { include: { influencer: { include: { profiles: { orderBy: { platform: "asc" } } } } } } },
  });
  const cards: CalibrationCard[] = rows.map((row) => {
    const profile = row.campaignCreator.influencer.profiles[0] ?? null;
    return {
      assessmentId: row.id,
      influencerId: row.campaignCreator.influencerId,
      name: row.campaignCreator.influencer.name,
      handle: profile ? displayHandle(profile.handle) : null,
      profileUrl: profile ? profileUrl(profile.platform, profile.handle) : null,
      followers: formatCount(profile?.followers ?? null),
      bio: profile?.bio ?? null,
      captions: profile?.recentCaptions ?? [],
      score: row.score,
      reasons: row.reasons.split("\n").filter(Boolean),
      promptVersion: row.promptVersion,
      verdict: row.reviewerVerdict,
      note: row.reviewerNote,
    };
  });

  const agreement = THRESHOLDS.map((threshold) => {
    const agree = reviewed.filter((row) => (row.score >= threshold) === row.reviewerVerdict).length;
    return { threshold, rate: reviewed.length > 0 ? Math.round((agree / reviewed.length) * 100) : null };
  });

  return (
    <>
      <PageHeader
        title="Scoring calibration"
        meta="Thirty random scored creators. Say yes or no as you would in the review queue; the agreement rate shows how far the AI's score is from your judgement, and the prompt is tuned in Settings."
      >
        {BRANDS.map((brand) => (
          <Link key={brand.id} href={`/admin/calibration?brand=${brand.id}`} className="chip" aria-current={brand.id === brandId ? "true" : undefined}>
            {brand.name}
          </Link>
        ))}
      </PageHeader>

      <Panel plain title="Agreement so far" className="mb-8">
        <p className="pt-3 text-muted-foreground">
          {reviewed.length === 0
            ? `No verdicts recorded yet for this brand. ${totals} creators have been scored.`
            : `${reviewed.length} verdicts recorded of ${totals} scored. "Agree" means you said yes where the score was at or above the threshold, or no where it was below.`}
        </p>
        {reviewed.length > 0 ? (
          <dl className="mt-3 flex flex-wrap gap-8">
            {agreement.map((row) => (
              <div key={row.threshold}>
                <dt className="eyebrow">Threshold {row.threshold}</dt>
                <dd className="stat-number text-2xl">{row.rate === null ? "–" : `${row.rate}%`}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </Panel>

      {cards.length === 0 ? (
        <p className="py-10 text-center text-muted-foreground">
          {totals === 0 ? "Nothing has been scored for this brand yet. Run AI scoring on a campaign first." : "Every scored creator of this brand has a verdict. Score more creators to continue."}
        </p>
      ) : (
        <CalibrationCards cards={cards} />
      )}
    </>
  );
}
