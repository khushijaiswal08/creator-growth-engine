import type { Metadata } from "next";
import { ArchiveSampleButton, SendSummaryButton } from "@/components/admin-forms";
import { PageHeader, Panel } from "@/components/panel";
import { db } from "@/lib/db";
import { emailConfigured } from "@/lib/email";
import { formatDateTime } from "@/lib/format";
import { hashtagBudget, HASHTAG_LIMIT } from "@/lib/hashtag-quota";
import { scoringConfigured, scoringModel } from "@/lib/scoring";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Admin" };

export default async function AdminPage() {
  await requireAdmin();

  const [sampleCreators, sampleCampaigns, budget, lastScoring] = await Promise.all([
    db.influencer.count({ where: { isSample: true, archived: false } }),
    db.campaign.count({ where: { isSample: true, status: { not: "archived" } } }),
    hashtagBudget(),
    db.scoringRun.findFirst({ orderBy: { startedAt: "desc" } }),
  ]);

  const services = [
    { name: "YouTube discovery", ready: Boolean(process.env.YOUTUBE_API_KEY?.trim()), setting: "YOUTUBE_API_KEY" },
    {
      name: "Instagram discovery (Meta)",
      ready: Boolean(process.env.META_ACCESS_TOKEN?.trim() && process.env.IG_BUSINESS_ID?.trim()),
      setting: "META_ACCESS_TOKEN and IG_BUSINESS_ID",
    },
    { name: `AI fit scoring (${scoringModel()})`, ready: scoringConfigured(), setting: "ANTHROPIC_API_KEY" },
  ];

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
                  {service.ready ? "Configured" : `Not configured: ${service.setting} is missing`}
                </dd>
              </div>
            ))}
          </dl>
          <p className="border-t px-4 py-2.5 text-muted-foreground">
            Keys are set in the server environment (.env locally, Project Settings on Vercel) and are never shown here.
          </p>
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
              ? `${formatDateTime(lastScoring.startedAt)}: ${lastScoring.scored} scored, ${lastScoring.failed} failed, ${lastScoring.requests} requests, ${lastScoring.inputTokens.toLocaleString("en-US")} input and ${lastScoring.outputTokens.toLocaleString("en-US")} output tokens (${lastScoring.model}).`
              : "No scoring has been run yet."}
          </p>
        </Panel>

        <Panel title="Weekly summary email">
          <div className="grid gap-3 p-4">
            <p>
              {emailConfigured()
                ? `Every Monday, last week's messages, replies, gifts shipped and content posted go to ${process.env.SUMMARY_EMAIL_TO?.trim()}.`
                : "Not configured: set SMTP_URL, SUMMARY_EMAIL_FROM and SUMMARY_EMAIL_TO in the server environment."}
            </p>
            <SendSummaryButton configured={emailConfigured()} />
          </div>
        </Panel>

        <Panel title="Sample data">
          <div className="grid gap-3 p-4">
            <p>
              {sampleCreators + sampleCampaigns === 0
                ? "All sample creators and campaigns are archived."
                : `${sampleCreators} sample creators and ${sampleCampaigns} sample campaigns are still visible.`}
            </p>
            <ArchiveSampleButton remaining={sampleCreators + sampleCampaigns} />
          </div>
        </Panel>
      </div>
    </>
  );
}
