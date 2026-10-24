import type { Metadata } from "next";
import Link from "next/link";
import { RachnaTipsToggle } from "@/components/rachna/rachna";
import { AutomationSettingsForm } from "@/components/journey-forms";
import { PageHeader, Panel } from "@/components/panel";
import { ScoringPromptForm, TargetsForm, type PromptVersionRow } from "@/components/settings-forms";
import { viewed } from "@/lib/brand-scope";
import { BRANDS } from "@/lib/brands";
import { db } from "@/lib/db";
import { formatDay } from "@/lib/format";
import { GIFT_RULES } from "@/lib/gift-rules";
import { brandTargets } from "@/lib/outreach-stats";
import { readerConfigured } from "@/lib/reply-reader-claude";
import { OFFER_STATUS_WHERE } from "@/lib/product-list";
import { activePromptFor } from "@/lib/scoring-prompts";
import { SELECTION_LINK_DAYS } from "@/lib/selection";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Settings" };

/**
 * Everything the team changes by number or by text, per brand: message
 * targets, the timers of each campaign, and (admins) the scoring prompt and
 * its weights, versioned. The gift rules are shown too, read from
 * config/gift-rules.json; changing those is a file edit and a redeploy.
 */
export default async function SettingsPage() {
  const user = await requireUser();
  const view = viewed(user);
  const isAdmin = user.role === "admin";
  const brandIds = BRANDS.filter((brand) => view.includes(brand.id)).map((brand) => brand.id);
  const targets = await brandTargets(brandIds);

  const brands = await Promise.all(
    BRANDS.filter((brand) => view.includes(brand.id)).map(async (brand) => {
      const [campaigns, articles, prompt, versions] = await Promise.all([
        db.campaign.findMany({
          where: { brandId: brand.id, status: { not: "archived" } },
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            followUpAfterDays: true,
            maxFollowUps: true,
            closeAfterDays: true,
            arrivalCheckDays: true,
            selectionWaitDays: true,
            deliveryWaitDays: true,
            contentReminderDays: true,
            contentDueDays: true,
            noContentAfterDays: true,
            giftArticles: true,
          },
        }),
        db.product.findMany({ where: { ...OFFER_STATUS_WHERE.offered, brandId: brand.id }, distinct: ["title"], orderBy: { title: "asc" }, select: { title: true } }),
        isAdmin ? activePromptFor(brand.id) : null,
        isAdmin
          ? db.scoringPrompt.findMany({ where: { brandId: brand.id }, orderBy: { version: "desc" }, include: { createdBy: { select: { name: true } } } })
          : [],
      ]);
      return { brand, campaigns, articles: articles.map((product) => product.title), prompt, versions };
    }),
  );

  return (
    <>
      <PageHeader title="Settings" meta="Targets, timers and the scoring prompt, per brand. Change a value, save, and it applies from the next check." />

      <section className="card mb-10 p-5">
        <h2 className="mb-3">Rachna, your guide</h2>
        <RachnaTipsToggle on={user.showRachnaTips} />
        <p className="mt-3 text-xs text-muted-foreground">Reply reading: {readerConfigured() ? "Claude reads the replies the team pastes in." : "built-in rules read the replies the team pastes in. Add ANTHROPIC_API_KEY on the server and Claude takes over on the same screens."}</p>
      </section>

      <div className="grid gap-12">
        {brands.map(({ brand, campaigns, articles, prompt, versions }) => {
          const target = targets.get(brand.id)!;
          return (
            <section key={brand.id} className="grid gap-6">
              <h2>{brand.name}</h2>

              <Panel plain title="Message targets">
                <p className="pt-3 text-muted-foreground">
                  What each person aims for. Today shows everyone&apos;s progress against these, and the Monday email reports it.
                </p>
                <TargetsForm brandId={brand.id} daily={target.daily} weekly={target.weekly} creatorConnectionsUrl={target.creatorConnectionsUrl} />
              </Panel>

              {campaigns.length === 0 ? (
                <p className="text-muted-foreground">No active campaign yet.</p>
              ) : (
                campaigns.map((campaign) => (
                  <Panel
                    key={campaign.id}
                    title={`Timers: ${campaign.name}`}
                    aside={
                      <Link href={`/campaigns/${campaign.id}`} className="link text-sm">
                        Open campaign
                      </Link>
                    }
                  >
                    <dl className="grid grid-cols-2 gap-x-6 gap-y-1 border-b px-4 py-3 text-sm sm:grid-cols-4">
                      <dt className="text-muted-foreground">Follow-up after</dt>
                      <dd>{campaign.followUpAfterDays} days without a reply</dd>
                      <dt className="text-muted-foreground">Follow-ups before No reply</dt>
                      <dd>
                        {campaign.maxFollowUps}, then closed {campaign.closeAfterDays} days after the last
                      </dd>
                      <dt className="text-muted-foreground">After delivery</dt>
                      <dd>
                        note the same day, arrival check after {campaign.arrivalCheckDays} days, reminder after {campaign.contentReminderDays}
                      </dd>
                      <dt className="text-muted-foreground">Content due</dt>
                      <dd>{campaign.contentDueDays} days after delivery</dd>
                      <dt className="text-muted-foreground">No content delivered</dt>
                      <dd>{campaign.noContentAfterDays} days after it was due</dd>
                    </dl>
                    <details className="disclosure px-4 py-3">
                      <summary>Change these timings</summary>
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
                        articles={articles}
                        chosenArticles={campaign.giftArticles}
                      />
                    </details>
                  </Panel>
                ))
              )}

              {isAdmin && prompt ? (
                <Panel plain title="AI scoring prompt">
                  <p className="pt-3 text-muted-foreground">
                    What the model is told before it scores a creator for this brand, and how the 100 points are split. Saving makes a new
                    version; every score records the version that produced it. Use Admin &gt; Scoring calibration to see how well a version
                    agrees with the team.
                  </p>
                  <ScoringPromptForm
                    brandId={brand.id}
                    version={prompt.version}
                    guidance={prompt.guidance}
                    weights={prompt.weights}
                    versions={versions.map(
                      (row): PromptVersionRow => ({ version: row.version, active: row.active, note: row.note, createdAt: formatDay(row.createdAt), createdBy: row.createdBy.name }),
                    )}
                  />
                </Panel>
              ) : null}
            </section>
          );
        })}

        <Panel plain title="Gift order rules">
          <p className="pt-3 text-muted-foreground">
            An order is approved without a person only when it passes every rule below. These live in the file <code className="text-xs">config/gift-rules.json</code>;
            changing them is a small edit and a redeploy, and the activity log of every order names the rules it passed or failed.
          </p>
          <dl className="mt-3 grid grid-cols-[minmax(0,14rem)_minmax(0,1fr)] gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Ships to</dt>
            <dd>{GIFT_RULES.allowedCountries.join(", ")}</dd>
            <dt className="text-muted-foreground">Most items per order</dt>
            <dd>{GIFT_RULES.maxQuantity}</dd>
            <dt className="text-muted-foreground">Most expensive product</dt>
            <dd>{GIFT_RULES.maxProductPriceUsd === null ? "No limit" : `$${GIFT_RULES.maxProductPriceUsd} (Amazon price)`}</dd>
            <dt className="text-muted-foreground">Second gift to the same creator</dt>
            <dd>Needs a person within {GIFT_RULES.repeatGiftDays} days of the last</dd>
            <dt className="text-muted-foreground">Paid collaborations</dt>
            <dd>{GIFT_RULES.paidCollaborationNeedsApprovedFee ? "Need an approved fee first" : "No fee check"}</dd>
            <dt className="text-muted-foreground">Selection links</dt>
            <dd>Work for {SELECTION_LINK_DAYS} days and once</dd>
          </dl>
        </Panel>
      </div>
    </>
  );
}
