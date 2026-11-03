import { runAutomations } from "@/lib/automation";
import { settleStaleUploads } from "@/lib/content-upload";
import { refuseUnlessScheduler } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Called once a day by netlify/functions/daily-automations.mts with the shared secret.
 * The caller sends "Authorization: Bearer <CRON_SECRET>"; anything else is refused.
 */
export async function GET(request: Request) {
  const refused = refuseUnlessScheduler(request);
  if (refused) return refused;

  const summary = await runAutomations("cron");
  // Files whose upload page closed before reporting back: received if they arrived in full, archived if not.
  const uploads = await settleStaleUploads();
  return Response.json({ ok: true, ...summary, uploads });
}
