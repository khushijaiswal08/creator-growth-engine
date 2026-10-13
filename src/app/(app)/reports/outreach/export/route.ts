import { viewed } from "@/lib/brand-scope";
import { csvCell, csvResponse, fileSlug } from "@/lib/csv-out";
import { db } from "@/lib/db";
import { replyRate, weeklyStats } from "@/lib/outreach-stats";
import { requireUser } from "@/lib/session";

const COLUMNS = ["week_start", "person", "messages", "creators_messaged", "replies", "reply_rate_percent", "follow_ups", "agreed", "shipped", "posted"] as const;
const WEEKS = 8;

/** The outreach report as CSV, for the person's own brand (or the chosen campaign within it). */
export async function GET(request: Request) {
  const user = await requireUser();
  const view = viewed(user);
  const asked = new URL(request.url).searchParams.get("campaign");
  const campaign = asked ? await db.campaign.findFirst({ where: { id: asked, ...view.campaigns }, select: { id: true, name: true } }) : null;
  if (asked && !campaign) return new Response("Not found", { status: 404 });

  const weeks = await weeklyStats(campaign ? { id: campaign.id } : view.campaigns, WEEKS);
  const lines = [COLUMNS.join(",")];
  for (const week of weeks) {
    for (const person of week.people) {
      const rate = replyRate(person);
      lines.push(
        [week.weekStart.toISOString().slice(0, 10), person.name, person.messages, person.creators, person.replies, rate ?? "", person.followUps, person.agreed, person.shipped, person.posted]
          .map((value) => csvCell(value))
          .join(","),
      );
    }
  }
  return csvResponse(lines, `outreach-${fileSlug(campaign?.name ?? "all-campaigns")}.csv`);
}
