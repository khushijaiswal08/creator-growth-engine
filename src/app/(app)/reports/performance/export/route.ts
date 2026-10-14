import { viewed } from "@/lib/brand-scope";
import { csvCell, csvResponse, fileSlug } from "@/lib/csv-out";
import { db } from "@/lib/db";
import { bucketsFor, FIGURE_LABELS, figuresFor, resolvePeriod, type Figures } from "@/lib/performance-stats";
import { requireUser } from "@/lib/session";

const KEYS = Object.keys(FIGURE_LABELS) as (keyof Figures)[];

/** The performance dashboard as CSV: one row per week or month in the period, then the total. */
export async function GET(request: Request) {
  const user = await requireUser();
  const view = viewed(user);
  const params = new URL(request.url).searchParams;
  const period = resolvePeriod(params.get("period") ?? undefined, params.get("from") ?? undefined, params.get("to") ?? undefined);
  const asked = params.get("campaign");
  const campaign = asked ? await db.campaign.findFirst({ where: { id: asked, ...view.campaigns }, select: { id: true, name: true } }) : null;
  if (asked && !campaign) return new Response("Not found", { status: 404 });
  const where = campaign ? { id: campaign.id } : view.campaigns;

  const [buckets, total] = await Promise.all([bucketsFor(period, where), figuresFor(period, where)]);
  const lines = [["period", ...KEYS].join(",")];
  for (const bucket of buckets) lines.push([bucket.label, ...KEYS.map((key) => bucket.figures[key] ?? "")].map((value) => csvCell(value)).join(","));
  lines.push(["total", ...KEYS.map((key) => total[key] ?? "")].map((value) => csvCell(value)).join(","));
  return csvResponse(lines, `performance-${fileSlug(campaign?.name ?? "all-campaigns")}-${period.key}.csv`);
}
