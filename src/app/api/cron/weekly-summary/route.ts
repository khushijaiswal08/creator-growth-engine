import { refuseUnlessScheduler } from "@/lib/cron-auth";
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
  const refused = refuseUnlessScheduler(request);
  if (refused) return refused;

  const summary = await weeklySummary();
  const { subject, text } = summaryText(summary);
  const result = await sendSummaryEmail(subject, text);
  return Response.json({ ok: true, subject, ...result });
}
