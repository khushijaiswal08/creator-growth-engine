import { timingSafeEqual } from "node:crypto";
import { sendSummaryEmail } from "@/lib/email";
import { summaryText, weeklySummary } from "@/lib/weekly-summary";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Called by the scheduler every Monday (netlify/functions/weekly-summary.mts).
 * The caller sends "Authorization: Bearer <CRON_SECRET>"; anything else is refused.
 * Composes last week's figures per brand and emails them to the admin address.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return Response.json({ error: "CRON_SECRET is not set." }, { status: 503 });

  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return Response.json({ error: "Not authorised." }, { status: 401 });
  }

  const summary = await weeklySummary();
  const { subject, text } = summaryText(summary);
  const result = await sendSummaryEmail(subject, text);
  return Response.json({ ok: true, subject, ...result });
}
