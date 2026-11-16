import { BRANDS } from "@/lib/brands";
import { db } from "@/lib/db";
import { formatDay } from "@/lib/format";
import { formatUsd } from "@/lib/model-prices";
import { brandTargets, personStats, replyRate } from "@/lib/outreach-stats";
import { resolvePeriod } from "@/lib/performance-stats";

type BrandWeek = {
  brand: string;
  weeklyTarget: number;
  messagesByPerson: { name: string; count: number; creators: number; replies: number; rate: number | null }[];
  scoringCostUsd: number;
  scoringRuns: number;
  messages: number;
  replies: number;
  giftsShipped: number;
  contentPosted: number;
  newCreators: number;
  noContent: number;
};

type WeekSummary ={ from: Date; to: Date; brands: BrandWeek[] };

/** The week that just finished (Monday to Sunday in the app's time zone), per brand. */
export async function weeklySummary(now = new Date()): Promise<WeekSummary> {
  const { from, to } = resolvePeriod("last-week", undefined, undefined, now);
  const inWeek = { gte: from, lt: to };

  const targets = await brandTargets(BRANDS.map((brand) => brand.id));
  const brands = await Promise.all(
    BRANDS.map(async (brand) => {
      const campaign = { brandId: brand.id };
      const ofBrand = { campaignCreator: { campaign } };
      const [people, replies, giftsShipped, contentPosted, newCreators, noContent, scoring] = await Promise.all([
        personStats({ from, to }, campaign),
        db.message.count({ where: { direction: "inbound", sentAt: inWeek, ...ofBrand } }),
        db.giftOrder.count({ where: { shippedAt: inWeek, ...ofBrand } }),
        db.post.count({ where: { createdAt: inWeek, ...ofBrand } }),
        db.campaignCreator.count({ where: { createdAt: inWeek, campaign } }),
        db.campaignCreator.count({ where: { status: "no_content", updatedAt: inWeek, campaign } }),
        db.scoringRun.aggregate({ where: { startedAt: inWeek, campaign }, _sum: { estimatedCostUsd: true }, _count: { _all: true } }),
      ]);
      const messagesByPerson = people.map((person) => ({ name: person.name, count: person.messages, creators: person.creators, replies: person.replies, rate: replyRate(person) }));
      return {
        brand: brand.name,
        weeklyTarget: targets.get(brand.id)?.weekly ?? 0,
        messagesByPerson,
        scoringCostUsd: Number(scoring._sum.estimatedCostUsd ?? 0),
        scoringRuns: scoring._count._all,
        messages: messagesByPerson.reduce((sum, row) => sum + row.count, 0),
        replies,
        giftsShipped,
        contentPosted,
        newCreators,
        noContent,
      };
    }),
  );
  return { from, to, brands };
}

/** Plain text, so it reads the same in every mail client. */
export function summaryText(summary: WeekSummary): { subject: string; text: string } {
  const lastDay = new Date(summary.to.getTime() - 1);
  const subject = `Creator Setu: week of ${formatDay(summary.from)} to ${formatDay(lastDay)}`;
  const lines = [subject, ""];
  for (const brand of summary.brands) {
    lines.push(brand.brand);
    lines.push(`  Messages sent: ${brand.messages}${brand.weeklyTarget > 0 ? ` (target ${brand.weeklyTarget} per person)` : ""}`);
    for (const person of brand.messagesByPerson) {
      lines.push(`    ${person.name}: ${person.count} vs target ${brand.weeklyTarget}, ${person.replies} replies${person.rate !== null ? ` (${person.rate}% of ${person.creators} creators)` : ""}`);
    }
    lines.push(`  Replies logged: ${brand.replies}`);
    lines.push(`  Gifts shipped: ${brand.giftsShipped}`);
    lines.push(`  Content posted: ${brand.contentPosted}`);
    lines.push(`  Creators added: ${brand.newCreators}`);
    lines.push(`  Took a gift, never posted: ${brand.noContent}`);
    if (brand.scoringRuns > 0) lines.push(`  AI scoring: ${brand.scoringRuns} runs, about ${formatUsd(brand.scoringCostUsd)}`);
    lines.push("");
  }
  lines.push("Sent by Creator Setu every Monday. Figures are the week just finished.");
  return { subject, text: lines.join("\n") };
}
