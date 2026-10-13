import { db } from "@/lib/db";
import { discoverySlice } from "@/lib/discovery";
import { scoringSlice } from "@/lib/scoring";

/**
 * Long jobs (discovery, AI scoring) never run inside one request. They are
 * split into slices that each finish in a few seconds. The screen that
 * started a job keeps asking for the next slice while someone is watching;
 * this tick, called by a scheduled function every two minutes, continues any
 * running job nobody is watching, one slice per run per tick, within a time
 * budget so the tick itself stays short.
 */
export type TickSummary = { discovery: { runId: string; done: boolean }[]; scoring: { runId: string; done: boolean }[]; skipped: number };

export async function tickJobs(now = new Date(), budgetMs = 6000): Promise<TickSummary> {
  const started = Date.now();
  const summary: TickSummary = { discovery: [], scoring: [], skipped: 0 };
  const free = { OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] };

  const discoveries = await db.discoveryRun.findMany({ where: { status: "running", ...free }, orderBy: { startedAt: "asc" }, take: 5, select: { id: true } });
  for (const run of discoveries) {
    if (Date.now() - started > budgetMs) {
      summary.skipped += 1;
      continue;
    }
    const result = await discoverySlice(run.id, now);
    summary.discovery.push({ runId: run.id, done: result.done });
  }

  const scorings = await db.scoringRun.findMany({ where: { status: "running", ...free }, orderBy: { startedAt: "asc" }, take: 5, select: { id: true } });
  for (const run of scorings) {
    if (Date.now() - started > budgetMs) {
      summary.skipped += 1;
      continue;
    }
    const result = await scoringSlice(run.id, now);
    summary.scoring.push({ runId: run.id, done: result.status !== "running" });
  }
  return summary;
}
