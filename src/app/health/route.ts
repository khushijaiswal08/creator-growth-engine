import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Uptime check. Public, so it reveals nothing beyond "up" or "down": no
 * versions, counts, hosts or error text.
 */
export async function GET() {
  let database = false;
  try {
    await db.$queryRaw`SELECT 1`;
    database = true;
  } catch (error) {
    console.error("Health check: database unreachable", error);
  }

  return Response.json(
    { status: database ? "ok" : "degraded", database },
    { status: database ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
