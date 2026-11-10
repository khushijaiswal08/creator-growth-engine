import type { Metadata } from "next";
import { ArchiveSampleButton, SendSummaryButton } from "@/components/admin-forms";
import { MarketplaceFieldsButton } from "@/components/marketplace-fields";
import { PageHeader, Panel } from "@/components/panel";
import { db } from "@/lib/db";
import { formatUsd } from "@/lib/model-prices";
import { emailConfigured } from "@/lib/email";
import { formatDateTime } from "@/lib/format";
import { hashtagBudget, HASHTAG_LIMIT } from "@/lib/hashtag-quota";
import { marketplaceStatus } from "@/lib/marketplace-status";
import { RUN_STATUS_LABELS } from "@/lib/discovery-labels";
import { mcfConfigured } from "@/lib/mcf";
import { BRANDS } from "@/lib/brands";
import { storageMode } from "@/lib/content-storage";
import { scoringConfigured, scoringModel } from "@/lib/scoring";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Admin" };

export default async function AdminPage() {
  await requireAdmin();

  const [sampleCreators, sampleCampaigns, budget, lastScoring, marketplace] = await Promise.all([
    db.influencer.count({ where: { isSample: true, archived: false } }),
    db.campaign.count({ where: { isSample: true, status: { not: "archived" } } }),
    hashtagBudget(),
    db.scoringRun.findFirst({ orderBy: { startedAt: "desc" } }),
    marketplaceStatus(),
  ]);
  const sampleRemaining = sampleCreators + sampleCampaigns;

  const services = [
    { name: "YouTube discovery", ready: Boolean(process.env.YOUTUBE_API_KEY?.trim()), setting: "YOUTUBE_API_KEY" },
    {
      name: "Instagram hashtag search (Meta)",
      ready: Boolean(process.env.META_ACCESS_TOKEN?.trim() && process.env.IG_BUSINESS_ID?.trim()),
      // The same two settings as the Creator Marketplace: name only the ones that are empty.
      setting: marketplace.missing.join(" and "),
    },
    { name: "Instagram Creator Marketplace", ready: marketplace.configured, setting: marketplace.missing.map((name) => (name === "META_ACCESS_TOKEN" ? "META_ACCESS_TOKEN (a Page access token)" : name)).join(" and ") },
    { name: `AI fit scoring (${scoringModel()})`, ready: scoringConfigured(), setting: "ANTHROPIC_API_KEY" },
    { name: "Content library storage (Cloudflare R2)", ready: storageMode() === "s3", setting: "CONTENT_S3_ENDPOINT, CONTENT_S3_BUCKET, CONTENT_S3_ACCESS_KEY_ID and CONTENT_S3_SECRET_ACCESS_KEY" },
    ...BRANDS.map((brand) => ({ name: `One-click Amazon orders, ${brand.name}`, ready: mcfConfigured(brand.id), setting: `SPAPI_LWA_CLIENT_ID, SPAPI_LWA_CLIENT_SECRET and SPAPI_REFRESH_TOKEN_${brand.id.toUpperCase().replace(/-/g, "_")}` })),
  ];
  const emailReady = emailConfigured();

  return (
    <>
      <PageHeader title="Admin" />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Connected services">
          <dl className="divide-y">
            {services.map((service) => (
              <div key={service.name} className="flex items-baseline justify-between gap-3 px-4 py-2.5">
                <dt className="font-medium">{service.name}</dt>
                <dd className={service.ready ? "" : "text-muted-foreground"}>
                  {service.ready ? "Configured" : `Not configured: ${service.setting} ${service.setting.includes(" and ") ? "are" : "is"} missing`}
                </dd>
              </div>
            ))}
          </dl>
          <p className="border-t px-4 py-2.5 text-muted-foreground">
            Keys are set in the server environment (.env locally, Site configuration › Environment variables on Netlify) and are never shown here.
          </p>
        </Panel>

        <Panel title="Instagram Creator Marketplace">
          <div className="grid gap-2 p-4">
            <dl className="grid gap-1 text-sm">
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-muted-foreground">Status:</dt>
                <dd>{marketplace.configured ? "Configured (token and business account set; whether Meta accepts the token shows on the first run)" : `Not configured: ${marketplace.missing.join(" and ")} ${marketplace.missing.length > 1 ? "are" : "is"} missing`}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-muted-foreground">Last run:</dt>
                <dd>{marketplace.lastRun ? `${formatDateTime(marketplace.lastRun.at)}, ${RUN_STATUS_LABELS[marketplace.lastRun.status as keyof typeof RUN_STATUS_LABELS] ?? marketplace.lastRun.status}, for "${marketplace.lastRun.campaign}"` : "never"}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-muted-foreground">Last error:</dt>
                <dd className="min-w-0 break-words">{marketplace.lastError ? `${formatDateTime(marketplace.lastError.at)}: ${marketplace.lastError.message}` : "none"}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-muted-foreground">Requests in the last hour:</dt>
                <dd>{marketplace.requestsLastHour}</dd>
              </div>
              <div className="flex flex-wrap gap-x-2">
                <dt className="text-muted-foreground">Fields requested:</dt>
                <dd>{marketplace.fields.length > 0 ? marketplace.fields.join(", ") : "none yet (Meta returns creator ids only)"}</dd>
              </div>
            </dl>
            <MarketplaceFieldsButton configured={marketplace.configured} />
          </div>
        </Panel>

        <Panel title="Instagram hashtag allowance">
          <div className="grid gap-1 p-4">
            <p>
              <span className="stat-number text-2xl">{budget.used}</span> of{" "}
              {HASHTAG_LIMIT} different hashtags used in the last 7 days. {budget.remaining} left.
            </p>
            <p className="text-muted-foreground">
              {budget.activeTags.length > 0
                ? `In use: ${budget.activeTags.map((tag) => `#${tag}`).join(", ")}`
                : "No hashtags searched in the last 7 days."}
            </p>
          </div>
        </Panel>

        <Panel title="Last AI scoring run">
          <p className="p-4">
            {lastScoring
              ? `${formatDateTime(lastScoring.startedAt)}: ${lastScoring.scored} scored, ${lastScoring.failed} failed, ${lastScoring.requests} requests, ${lastScoring.inputTokens.toLocaleString("en-US")} input and ${lastScoring.outputTokens.toLocaleString("en-US")} output tokens, about ${formatUsd(lastScoring.estimatedCostUsd === null ? null : Number(lastScoring.estimatedCostUsd))} (${lastScoring.model}, prompt ${lastScoring.promptVersion}).`
              : "No scoring has been run yet."}
          </p>
        </Panel>

        <Panel title="Weekly summary email">
          <div className="grid gap-3 p-4">
            <p>
              {emailReady
                ? `Every Monday, last week's messages, replies, gifts shipped and content posted go to ${process.env.SUMMARY_EMAIL_TO?.trim()}.`
                : "Not configured: set SMTP_URL, SUMMARY_EMAIL_FROM and SUMMARY_EMAIL_TO in the server environment."}
            </p>
            <SendSummaryButton configured={emailReady} />
          </div>
        </Panel>

        <Panel title="Sample data">
          <div className="grid gap-3 p-4">
            <p>
              {sampleRemaining === 0
                ? "All sample creators and campaigns are archived."
                : `${sampleCreators} sample creators and ${sampleCampaigns} sample campaigns are still visible.`}
            </p>
            <ArchiveSampleButton remaining={sampleRemaining} />
          </div>
        </Panel>
      </div>
    </>
  );
}
