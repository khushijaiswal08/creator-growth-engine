"use client";

import { useState, useTransition } from "react";
import { runDiscoveryAction, type DiscoveryActionResult } from "@/actions/discovery";
import { NativeSelect } from "@/components/native-select";
import { Button } from "@/components/ui/button";

const SOURCES = [
  { value: "youtube", label: "YouTube" },
  { value: "meta_free", label: "Instagram hashtags (Meta)" },
];

const STATUS_TEXT: Record<string, string> = {
  completed: "Completed",
  stopped_quota: "Stopped early: quota reached",
  not_configured: "Not configured",
  failed: "Failed",
  running: "Running",
};

/** Admin-only control on the campaign page. Shows the summary of the run it just started. */
export function DiscoveryPanel({ campaignId, hasKeywords }: { campaignId: string; hasKeywords: boolean }) {
  const [source, setSource] = useState("youtube");
  const [result, setResult] = useState<DiscoveryActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  function run() {
    startTransition(async () => {
      setResult(await runDiscoveryAction(campaignId, source));
    });
  }

  return (
    <div className="grid gap-3 p-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1.5">
          <label htmlFor="discovery-source" className="text-sm font-medium">
            Source
          </label>
          <NativeSelect
            id="discovery-source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            disabled={pending}
            className="w-64"
          >
            {SOURCES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="button" onClick={run} disabled={pending || !hasKeywords}>
          {pending ? "Searching..." : "Run discovery"}
        </Button>
        <p className="text-muted-foreground">
          {hasKeywords
            ? "Searches with this campaign's niche keywords and adds new creators as Discovered. Nobody is contacted."
            : "Add niche keywords to this campaign before running discovery."}
        </p>
      </div>

      {result && !result.ok ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
          {result.error}
        </p>
      ) : null}

      {result?.ok ? (
        <div role="status" className="rounded-md border">
          <p className="border-b px-3 py-2 font-medium">{STATUS_TEXT[result.summary.status] ?? result.summary.status}</p>
          <dl className="grid grid-cols-4 divide-x text-center">
            {(
              [
                ["Found", result.summary.found],
                ["New", result.summary.added],
                ["Already known", result.summary.alreadyKnown],
                ["Skipped", result.summary.skipped],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="px-3 py-2">
                <dt className="eyebrow">{label}</dt>
                <dd className="stat-number text-xl">{value}</dd>
              </div>
            ))}
          </dl>
          {result.summary.note ? <p className="border-t px-3 py-2 text-muted-foreground">{result.summary.note}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
