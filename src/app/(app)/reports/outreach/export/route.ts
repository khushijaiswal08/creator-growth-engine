import { viewed } from "@/lib/brand-scope";
import { csvLine, csvResponse, fileSlug } from "@/lib/csv-out";
import { db } from "@/lib/db";
import { isoDay } from "@/lib/format";
import { OUTREACH_WEEKS, replyRate, weeklyStats } from "@/lib/outreach-stats";
import { requireUser } from "@/lib/session";

const COLUMNS = ["week_start", "person", "messages", "creators_messaged", "replies", "reply_rate_percent", "follow_ups", "agreed", "shipped", "posted"] as const;

/** The outreach report as CSV, for the person's own brand (or the chosen campaign within it). */
export async function GET(request: Request) {
  const user = await requireUser();
  const view = viewed(user);
  const asked = new URL(request.url).searchParams.get("campaign");
  const campaign = asked ? await db.campaign.findFirst({ where: { id: asked, ...view.campaigns }, select: { id: true, name: true } }) : null;
  if (asked && !campaign) return new Response("Not found", { status: 404 });

  const weeks = await weeklyStats(campaign ? { id: campaign.id } : view.campaigns, OUTREACH_WEEKS);
  const lines = [COLUMNS.join(",")];
  for (const week of weeks) {
    for (const person of week.people) {
      const rate = replyRate(person);
      lines.push(csvLine([isoDay(week.weekStart), person.name, person.messages, person.creators, person.replies, rate ?? "", person.followUps, person.agreed, person.shipped, person.posted]));
    }
  }
  return csvResponse(lines, `outreach-${fileSlug(campaign?.name ?? "all-campaigns")}.csv`);
}
