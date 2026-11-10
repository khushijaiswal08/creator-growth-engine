"use client";

import { useRef, useState } from "react";
import { continueDiscoveryAction, startDiscoveryAction } from "@/actions/discovery";
import { NativeSelect } from "@/components/native-select";
import { Button } from "@/components/ui/button";
import type { DiscoverySummary } from "@/lib/discovery";
import { DISCOVERY_SOURCES, SOURCE_LABELS } from "@/lib/discovery-labels";
import type { MarketplaceReport } from "@/lib/fetching/adapters/creator-marketplace";
import type { MetaReport as MetaReportFull } from "@/lib/fetching/adapters/meta-free";
import type { YoutubeReport as YoutubeReportFull } from "@/lib/fetching/adapters/youtube";

const SOURCES = DISCOVERY_SOURCES.map((value) => ({ value, label: SOURCE_LABELS[value] }));

const STATUS_TEXT: Record<string, string> = {
  completed: "Completed",
  stopped_quota: "Stopped early: quota reached",
  not_configured: "Not configured",
  failed: "Failed",
  running: "Running",
};

type MetaReport = Partial<MetaReportFull>;
type YoutubeReport = Partial<YoutubeReportFull>;

/** What the live service answered, step by step, in plain words. */
function ReportLines({ source, report }: { source: string; report: Record<string, unknown> | null }) {
  if (!report) return null;
  if (source === "meta_marketplace") {
    const r = report as Partial<MarketplaceReport>;
    return (
      <ul className="grid gap-0.5 border-t px-3 py-2 text-xs text-muted-foreground">
        <li>
          Pages read: {r.pages ?? 0}. Creators returned: {r.creatorsSeen ?? 0}
          {r.withoutUsername ? `, of which ${r.withoutUsername} without a username (not added)` : ""}.
        </li>
        <li>Fields asked for: {r.fieldsRequested && r.fieldsRequested.length > 0 ? r.fieldsRequested.join(", ") : "none yet (Meta returns ids only)"}.</li>
        {r.fieldsReturned && r.fieldsReturned.length > 0 ? <li>Fields Meta returned: {r.fieldsReturned.join(", ")}.</li> : null}
        <li>{r.keywordFilter ? `Filtered by: ${r.keywordFilter}.` : "Not filtered by the campaign's keywords: Meta's filter for this list is not confirmed yet."}</li>
      </ul>
    );
  }
  if (source === "youtube") {
    const r = report as YoutubeReport;
    const skipped = r.searchesSkippedForBudget ?? [];
    return (
      <ul className="grid gap-0.5 border-t px-3 py-2 text-xs text-muted-foreground">
        {(r.searches ?? []).map((search) => (
          <li key={search.keyword}>
            Search &quot;{search.keyword}&quot;: {search.channelIds} channels ({search.units} units)
          </li>
        ))}
        {skipped.length > 0 ? <li>Not searched (80% of the daily quota): {skipped.join(", ")}</li> : null}
        <li>
          Channel details read: {r.channelsFetched ?? 0}. Latest uploads read: {r.uploadsRead ?? 0}.
          {r.budget !== null && r.budget !== undefined ? ` Allowance left when this run started: ${r.budget} units.` : ""}
        </li>
      </ul>
    );
  }
  const r = report as MetaReport;
  const pending = r.pending?.length ?? 0;
  return (
    <ul className="grid gap-0.5 border-t px-3 py-2 text-xs text-muted-foreground">
      {(r.hashtags ?? []).map((tag) => (
        <li key={tag.tag}>
          #{tag.tag}: {tag.refused ? "not searched (30-hashtag rule)" : tag.hashtagId ? `hashtag id ${tag.hashtagId}, ${tag.posts} posts` : "no hashtag id returned"}
        </li>
      ))}
      {r.oembed ? (
        <li>
          oEmbed: {r.oembed.calls} calls, author named on {r.oembed.withAuthor}, missing on {r.oembed.withoutAuthor}, failed {r.oembed.failed}.
        </li>
      ) : null}
      {r.businessDiscovery ? (
        <li>
          Business Discovery: {r.businessDiscovery.succeeded} of {r.businessDiscovery.attempted} accounts returned stats.
        </li>
      ) : null}
      {pending > 0 ? <li>{pending} posts are waiting in the review queue for a handle.</li> : null}
    </ul>
  );
}

/** Admin-only control on the campaign page. Starts a run and follows it slice by slice. */
export function DiscoveryPanel({ campaignId, hasKeywords, marketplace }: { campaignId: string; hasKeywords: boolean; marketplace: { missing: string[]; fields: string[] } }) {
  const [source, setSource] = useState("youtube");
  const [summary, setSummary] = useState<DiscoverySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const stop = useRef(false);

  async function run() {
    setPending(true);
    setError(null);
    setSummary(null);
    stop.current = false;
    let result = await startDiscoveryAction(campaignId, source);
    while (result.ok) {
      setSummary(result.summary);
      if (result.summary.done || stop.current) break;
      result = await continueDiscoveryAction(result.summary.runId);
    }
    if (!result.ok) setError(result.error);
    setPending(false);
  }

  return (
    <div className="grid gap-3 p-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1.5">
          <label htmlFor="discovery-source" className="text-sm font-medium">
            Source
          </label>
          <NativeSelect id="discovery-source" value={source} onChange={(event) => setSource(event.target.value)} disabled={pending} className="w-64">
            {SOURCES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="button" onClick={run} disabled={pending || (!hasKeywords && source !== "meta_marketplace")}>
          {pending ? "Searching..." : "Run discovery"}
        </Button>
        {pending ? (
          <Button type="button" variant="outline" onClick={() => (stop.current = true)}>
            Leave it running in the background
          </Button>
        ) : null}
        <p className="text-muted-foreground">
          {source === "meta_marketplace"
            ? `Meta's Creator Marketplace list for the connected Instagram business account. Not filtered by this campaign's keywords yet (Meta's filter is not confirmed): a run reads up to 100 creators and AI fit scoring sorts them against the brief. New creators are added as Discovered; nobody is contacted.${marketplace.missing.length === 0 ? "" : ` Not configured yet: ${marketplace.missing.join(" and ")} ${marketplace.missing.length > 1 ? "are" : "is"} missing on the server (the token must be a Page access token).`}${marketplace.fields.length === 0 ? " No creator fields are requested yet, so Meta returns ids only and nobody can be added until the username field is listed." : ""}`
            : hasKeywords
              ? "Searches with this campaign's niche keywords and adds new creators as Discovered. Nobody is contacted. A run continues by itself if you leave the page."
              : "Add niche keywords to this campaign before running discovery."}
        </p>
      </div>

      {error ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
          {error}
        </p>
      ) : null}

      {summary ? (
        <div role="status" className="rounded-md border">
          <p className="border-b px-3 py-2 font-medium">
            {summary.done ? (STATUS_TEXT[summary.status] ?? summary.status) : "Running, slice by slice..."}
          </p>
          <dl className="grid grid-cols-5 divide-x text-center">
            {(
              [
                ["Found", summary.found],
                ["New", summary.added],
                ["Already known", summary.alreadyKnown],
                ["Skipped", summary.skipped],
                [summary.source === "youtube" ? "Quota units" : "API calls", summary.quotaUsed],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="px-3 py-2">
                <dt className="eyebrow">{label}</dt>
                <dd className="stat-number text-xl">{value}</dd>
              </div>
            ))}
          </dl>
          <ReportLines source={summary.source} report={summary.report} />
          {summary.note ? <p className="border-t px-3 py-2 text-muted-foreground">{summary.note}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
