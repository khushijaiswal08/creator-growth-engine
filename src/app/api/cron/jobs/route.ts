import { BRANDS } from "@/lib/brands";
import { refuseUnlessScheduler } from "@/lib/cron-auth";
import { tickJobs } from "@/lib/jobs";
import { mcfConfigured } from "@/lib/mcf";
import { syncAmazonOrders } from "@/lib/mcf-flow";

export const dynamic = "force-dynamic";

/**
 * Called every ten minutes in working hours by netlify/functions/job-tick.mts
 * with the shared secret. Continues any running discovery or scoring job by
 * one slice, and on the first tick of each hour reads back what Amazon did
 * with the gifts sent through one-click MCF (only when a brand has the keys).
 */
export async function GET(request: Request) {
  const refused = refuseUnlessScheduler(request);
  if (refused) return refused;
  const now = new Date();
  const started = Date.now();
  const jobs = await tickJobs(now);
  // The Amazon check gets what is left of the run, at most four seconds; whatever it does not reach is seen next hour.
  const budgetMs = Math.min(4_000, 8_000 - (Date.now() - started));
  const amazon = now.getUTCMinutes() < 10 && budgetMs > 1_000 && BRANDS.some((brand) => mcfConfigured(brand.id)) ? await syncAmazonOrders(now, { budgetMs }) : null;
  return Response.json({ ok: true, ...jobs, amazon });
}
