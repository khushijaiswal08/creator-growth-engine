import { timingSafeEqual } from "node:crypto";

/** The bearer check every /api/cron route makes: the refusal to send back, or null when the caller holds CRON_SECRET. */
export function refuseUnlessScheduler(request: Request): Response | null {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return Response.json({ error: "CRON_SECRET is not set." }, { status: 503 });
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return Response.json({ error: "Not authorised." }, { status: 401 });
  }
  return null;
}
