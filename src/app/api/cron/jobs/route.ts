import { timingSafeEqual } from "node:crypto";
import { tickJobs } from "@/lib/jobs";

export const dynamic = "force-dynamic";

/**
 * Called every two minutes by netlify/functions/job-tick.mts with the shared
 * secret. Continues any running discovery or scoring job by one slice.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return Response.json({ error: "CRON_SECRET is not set." }, { status: 503 });
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return Response.json({ error: "Not authorised." }, { status: 401 });
  }
  return Response.json({ ok: true, ...(await tickJobs()) });
}
