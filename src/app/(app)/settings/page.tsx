import type { Metadata } from "next";
import Link from "next/link";
import { AutomationSettingsForm } from "@/components/journey-forms";
import { PageHeader, Panel } from "@/components/panel";
import { viewed } from "@/lib/brand-scope";
import { BRANDS } from "@/lib/brands";
import { db } from "@/lib/db";
import { GIFT_RULES } from "@/lib/gift-rules";
import { OFFER_STATUS_WHERE } from "@/lib/product-list";
import { SELECTION_LINK_DAYS } from "@/lib/selection";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Settings" };

/**
 * The timers, per brand and campaign, printed where the team can read and
 * change them without code. The gift rules are shown too, read from
 * config/gift-rules.json; changing those is a file edit and a redeploy.
 */
export default async function SettingsPage() {
  const user = await requireUser();
  const view = viewed(user);

  const brands = await Promise.all(
    BRANDS.filter((brand) => view.includes(brand.id)).map(async (brand) => {
      const [campaigns, articles] = await Promise.all([
        db.campaign.findMany({
          where: { brandId: brand.id, status: { not: "archived" } },
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            status: true,
            followUpAfterDays: true,
            maxFollowUps: true,
            closeAfterDays: true,
            selectionWaitDays: true,
            deliveryWaitDays: true,
            contentReminderDays: true,
            contentDueDays: true,
            noContentAfterDays: true,
            giftArticles: true,
          },
        }),
        db.product.findMany({
          where: { ...OFFER_STATUS_WHERE.offered, brandId: brand.id },
          distinct: ["title"],
          orderBy: { title: "asc" },
          select: { title: true },
        }),
      ]);
      return { brand, campaigns, articles: articles.map((product) => product.title) };
    }),
  );

  return (
    <>
      <PageHeader
        title="Settings"
        meta="How long the portal waits at each step, per campaign. Change a number, save, and Today is refreshed with the new timing."
      />

      <div className="grid gap-12">
        {brands.map(({ brand, campaigns, articles }) => (
          <section key={brand.id}>
            <h2 className="mb-1">{brand.name}</h2>
            {campaigns.length === 0 ? (
              <p className="text-muted-foreground">No active campaign yet.</p>
            ) : (
              <div className="grid gap-6">
                {campaigns.map((campaign) => (
                  <Panel
                    key={campaign.id}
                    title={campaign.name}
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
                ))}
              </div>
            )}
          </section>
        ))}

        <Panel plain title="Gift order rules">
          <p className="pt-3 text-muted-foreground">
            An order is approved without a person only when it passes every rule below. These live in the file{" "}
            <code className="text-xs">config/gift-rules.json</code>; changing them is a small edit and a redeploy, and the
            activity log of every order names the rules it passed or failed.
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
