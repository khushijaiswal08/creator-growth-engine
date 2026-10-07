import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Operations check, guarded by CRON_SECRET like the schedulers. Runs the kind
 * of database queries the app makes and reports what went wrong when they
 * fail, so a broken deployment can be diagnosed without server access. The
 * public /health deliberately says nothing beyond up or down; this one says
 * why, and only to someone holding the secret.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return Response.json({ error: "CRON_SECRET is not set." }, { status: 503 });
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return Response.json({ error: "Not authorised." }, { status: 401 });
  }

  const results: Record<string, string> = {};
  const check = async (name: string, run: () => Promise<unknown>) => {
    try {
      await run();
      results[name] = "ok";
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      // Never echo a connection string.
      results[name] = message.replace(/postgres(ql)?:\/\/\S+/gi, "<database url>").slice(0, 600);
    }
  };

  await check("raw", () => db.$queryRaw`SELECT 1`);
  await check("users", () => db.user.count());
  await check("creators", () => db.campaignCreator.count());
  await check("rateLimit", () => db.rateLimitHit.count());

  // Which database and which key, without revealing either: host and name only, and a short hash of the key.
  let database = "not set";
  try {
    const url = new URL(process.env.DATABASE_URL ?? "");
    database = `${url.hostname}${url.pathname}`;
  } catch {
    database = "unreadable";
  }
  const key = process.env.ADDRESS_ENCRYPTION_KEY?.trim();

  return Response.json({
    database,
    addressKeyFingerprint: key ? createHash("sha256").update(key).digest("hex").slice(0, 8) : null,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    netlify: process.env.NETLIFY === "true",
    timeZone: process.env.APP_TIME_ZONE ?? null,
    results,
  });
}
