import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/panel";
import { TidyUpForm } from "@/components/tidy-up-form";
import { viewed } from "@/lib/brand-scope";
import { brandName } from "@/lib/brands";
import { requireAdmin } from "@/lib/session";
import { CREATOR_STATUS_LABELS } from "@/lib/status";
import { tidyCandidates, tidyHistory } from "@/lib/tidy-up";
import { DEFAULT_TIDY_DAYS, TIDY_DAYS, TIDY_GROUPS } from "@/lib/tidy-up-rules";

export const metadata: Metadata = { title: "Tidy up old work" };

/**
 * Old imported work that keeps Home busy, grouped, with a choice per group.
 * The page is the preview: nothing changes until Apply, and Apply touches
 * only the creators listed here.
 */
export default async function TidyUpPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const user = await requireAdmin();
  const view = viewed(user);
  const asked = Number.parseInt((await searchParams).days ?? "", 10);
  const days = (TIDY_DAYS as readonly number[]).includes(asked) ? asked : DEFAULT_TIDY_DAYS;
  const [candidates, history] = await Promise.all([tidyCandidates(view, days), tidyHistory()]);
  const groups = TIDY_GROUPS.map((group) => ({
    key: group.key,
    title: group.title,
    about: group.about,
    actions: group.actions,
    rows: (candidates.get(group.key) ?? []).map((row) => ({ id: row.id, name: row.name, campaign: row.campaign, status: CREATOR_STATUS_LABELS[row.status], lastTouch: row.lastTouch })),
  }));
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);

  return (
    <>
      <PageHeader
        title="Tidy up old work"
        meta={`${total} ${total === 1 ? "creator" : "creators"} on Home that nobody has touched in ${days} days${view.brandId ? ` · ${brandName(view.brandId)} only` : " · both brands"}`}
      />
      <div className="mb-5 grid gap-3">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Old conversations from the imported sheets keep Home full. Choose what to do with each group below. This page is the preview: nothing changes until you press Apply, Apply touches only the creators listed, nothing is sent to anyone, and you can undo it afterwards.
        </p>
        <nav aria-label="Older than" className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-[13px] font-semibold text-muted-foreground">Not touched for</span>
          {TIDY_DAYS.map((value) => (
            <Link key={value} href={`/admin/tidy-up?days=${value}`} className="chip" aria-current={value === days ? "true" : undefined}>
              {value} days
            </Link>
          ))}
        </nav>
      </div>
      <TidyUpForm key={days} days={days} brand={view.brandId} groups={groups} history={history} />
    </>
  );
}
