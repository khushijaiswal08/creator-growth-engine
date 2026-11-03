import { Trophy } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { InviteBackTable } from "@/components/invite-back-table";
import { PageHeader } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { viewed } from "@/lib/brand-scope";
import { brandName } from "@/lib/brands";
import { db } from "@/lib/db";
import { inviteBackList, OPEN_CAMPAIGN_STATUSES } from "@/lib/invite-back";
import { withQuery } from "@/lib/query-string";
import { requireUser } from "@/lib/session";
import { CAMPAIGN_STATUS_LABELS } from "@/lib/status";

export const metadata: Metadata = { title: "Invite back" };

const SHOW = { all: "Everyone proven", stars: "Stars only", ready: "Ready to gift now" } as const;
type ShowKey = keyof typeof SHOW;
const SHOW_KEYS = Object.keys(SHOW) as ShowKey[];
const OPEN_CAMPAIGN_ORDER = ["active", "draft", "paused"];

/**
 * Repeat collaborations: creators who already delivered content for us,
 * ready to be invited to an open campaign. A person picks the campaign and
 * the creators; they join as Approved with a welcome-back message waiting.
 */
export default async function InviteBackPage({ searchParams }: { searchParams: Promise<{ campaign?: string; show?: string }> }) {
  const view = viewed(await requireUser());
  const params = await searchParams;
  const show: ShowKey = SHOW_KEYS.includes(params.show as ShowKey) ? (params.show as ShowKey) : "all";

  // Active campaigns first, then drafts, then paused ones; newest first within each.
  const campaigns = (
    await db.campaign.findMany({
      where: { ...view.campaigns, status: { in: OPEN_CAMPAIGN_STATUSES } },
      orderBy: { createdAt: "desc" },
      select: { id: true, name: true, brandId: true, status: true },
    })
  ).sort((a, b) => OPEN_CAMPAIGN_ORDER.indexOf(a.status) - OPEN_CAMPAIGN_ORDER.indexOf(b.status));
  // The chosen campaign, else the newest active one.
  const campaign = campaigns.find((row) => row.id === params.campaign) ?? campaigns.find((row) => row.status === "active") ?? campaigns[0] ?? null;
  const all = await inviteBackList(view, campaign);
  const rows = all.filter((row) => (show === "stars" ? row.grade === "star" : show === "ready" ? row.invitable && row.giftAgainFrom === null : true));
  const brands = new Set(campaigns.map((row) => row.brandId));
  const href = (overrides: Record<string, string | undefined>) => withQuery("/influencers/invite-back", { campaign: campaign?.id, show: show === "all" ? undefined : show, ...overrides });

  return (
    <>
      <PageHeader title="Invite back" meta={`${all.length} proven ${all.length === 1 ? "creator" : "creators"}${campaign ? ` for ${brandName(campaign.brandId)}` : ""} · they delivered content before`}>
        <Button asChild variant="outline">
          <Link href="/influencers/ranking">
            <Trophy strokeWidth={2.4} />
            Ranking
          </Link>
        </Button>
      </PageHeader>

      <div className="mb-5 grid gap-3">
        <p className="max-w-3xl text-sm text-muted-foreground">
          Creators rated <b className="text-foreground">Star</b> or <b className="text-foreground">Good bet</b> from their work with {campaign ? brandName(campaign.brandId) : "us"}. Choose an open campaign, tick the creators, and press Invite: they join the campaign as Approved, with a welcome-back message ready on Home. Nothing is sent until you send it.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          {campaigns.length > 0 ? (
            <form method="get" className="flex items-center gap-2 text-[13px] font-semibold text-muted-foreground">
              {show !== "all" ? <input type="hidden" name="show" value={show} /> : null}
              <label htmlFor="invite-campaign">Invite to</label>
              <select
                id="invite-campaign"
                name="campaign"
                defaultValue={campaign?.id}
                className="h-9 max-w-[22rem] rounded-xl border border-border-strong bg-surface px-3 text-[13px] font-bold text-foreground outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/20"
              >
                {campaigns.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                    {brands.size > 1 ? ` · ${brandName(row.brandId)}` : ""}
                    {row.status !== "active" ? ` (${CAMPAIGN_STATUS_LABELS[row.status]})` : ""}
                  </option>
                ))}
              </select>
              <Button type="submit" size="sm" variant="outline">
                Show
              </Button>
            </form>
          ) : (
            <span className="text-sm font-semibold text-danger-text">
              There is no open campaign to invite to. <Link href="/campaigns" className="link">Start one</Link> first.
            </span>
          )}
          <nav aria-label="Show" className="flex flex-wrap items-center gap-1.5">
            {SHOW_KEYS.map((key) => (
              <Link key={key} href={href({ show: key === "all" ? undefined : key })} className="chip" aria-current={show === key ? "true" : undefined}>
                {SHOW[key]}
              </Link>
            ))}
          </nav>
        </div>
      </div>

      <InviteBackTable rows={rows} campaign={campaign ? { id: campaign.id, name: campaign.name } : null} />
    </>
  );
}
