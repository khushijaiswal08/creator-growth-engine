import { timingSafeEqual } from "node:crypto";
import { runAutomations } from "@/lib/automation";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Called by the scheduler (Vercel Cron, see vercel.json) once a day.
 * Vercel sends "Authorization: Bearer <CRON_SECRET>"; anything else is refused.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return Response.json({ error: "CRON_SECRET is not set." }, { status: 503 });

  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return Response.json({ error: "Not authorised." }, { status: 401 });
  }

  const summary = await runAutomations("cron");
  return Response.json({ ok: true, ...summary });
}
