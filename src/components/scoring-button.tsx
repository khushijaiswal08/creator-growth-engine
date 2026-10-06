"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { scoreCampaignBatch } from "@/actions/scoring";
import { Button } from "@/components/ui/button";
import type { ScoringProgress } from "@/lib/scoring";

const tokens = new Intl.NumberFormat("en-US");

/** Admin-only. Runs AI fit scoring batch by batch and shows progress and token use. */
export function ScoringButton({ campaignId, unscored }: { campaignId: string; unscored: number }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ScoringProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const stopRequested = useRef(false);

  async function start() {
    setRunning(true);
    setError(null);
    setProgress(null);
    stopRequested.current = false;

    let runId: string | null = null;
    const failed: string[] = [];
    while (!stopRequested.current) {
      const result = await scoreCampaignBatch(campaignId, runId, failed);
      if (!result.ok) {
        setError(result.error);
        break;
      }
      runId = result.progress.runId;
      failed.push(...result.progress.failedIds);
      setProgress(result.progress);
      if (result.progress.status !== "running") break;
    }
    setRunning(false);
    router.refresh();
  }

  const done = progress && progress.status !== "running";

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={start} disabled={running || unscored === 0}>
          {running ? "Scoring..." : `Score discovered creators (${unscored})`}
        </Button>
        {running ? (
          <Button type="button" variant="outline" onClick={() => (stopRequested.current = true)}>
            Stop after this batch
          </Button>
        ) : null}
        <p className="text-muted-foreground">
          AI scoring recommends only. It moves Discovered to Scored and never approves anyone.
        </p>
      </div>

      {progress ? (
        <p role="status" className="rounded-md border px-3 py-2">
          {done ? "Finished: " : "Working: "}
          {progress.totals.scored} scored
          {progress.totals.failed > 0 ? `, ${progress.totals.failed} failed` : ""}
          {!done ? `, ${progress.remaining} to go` : ""}. Used {tokens.format(progress.totals.inputTokens)} input and{" "}
          {tokens.format(progress.totals.outputTokens)} output tokens in {progress.totals.requests} requests.
          {progress.note ? ` ${progress.note}` : ""}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
