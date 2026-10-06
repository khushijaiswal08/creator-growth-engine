import { BRANDS } from "@/lib/brands";
import { db } from "@/lib/db";
import { formatDay, startOfWeekInZone } from "@/lib/format";

const DAY = 24 * 60 * 60 * 1000;

export type BrandWeek = {
  brand: string;
  messagesByPerson: { name: string; count: number }[];
  messages: number;
  replies: number;
  giftsShipped: number;
  contentPosted: number;
  newCreators: number;
  noContent: number;
};

export type WeekSummary = { from: Date; to: Date; brands: BrandWeek[] };

/** The week that just finished (Monday to Sunday in the app's time zone), per brand. */
export async function weeklySummary(now = new Date()): Promise<WeekSummary> {
  const to = startOfWeekInZone(now);
  const from = new Date(to.getTime() - 7 * DAY);
  const inWeek = { gte: from, lt: to };

  const brands = await Promise.all(
    BRANDS.map(async (brand) => {
      const ofBrand = { campaignCreator: { campaign: { brandId: brand.id } } };
      const [sent, replies, giftsShipped, contentPosted, newCreators, noContent] = await Promise.all([
        db.message.groupBy({ by: ["userId"], where: { direction: "outbound", sentAt: inWeek, ...ofBrand }, _count: { _all: true } }),
        db.message.count({ where: { direction: "inbound", sentAt: inWeek, ...ofBrand } }),
        db.giftOrder.count({ where: { shippedAt: inWeek, ...ofBrand } }),
        db.post.count({ where: { createdAt: inWeek, ...ofBrand } }),
        db.campaignCreator.count({ where: { createdAt: inWeek, campaign: { brandId: brand.id } } }),
        db.campaignCreator.count({ where: { status: "no_content", updatedAt: inWeek, campaign: { brandId: brand.id } } }),
      ]);
      const people = await db.user.findMany({ where: { id: { in: sent.map((row) => row.userId) } }, select: { id: true, name: true } });
      const nameOf = new Map(people.map((person) => [person.id, person.name]));
      const messagesByPerson = sent
        .map((row) => ({ name: nameOf.get(row.userId) ?? "Someone", count: row._count._all }))
        .sort((a, b) => b.count - a.count);
      return {
        brand: brand.name,
        messagesByPerson,
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
  const subject = `Creator Growth: week of ${formatDay(summary.from)} to ${formatDay(lastDay)}`;
  const lines = [subject, ""];
  for (const brand of summary.brands) {
    lines.push(brand.brand);
    lines.push(`  Messages sent: ${brand.messages}`);
    for (const person of brand.messagesByPerson) lines.push(`    ${person.name}: ${person.count}`);
    lines.push(`  Replies logged: ${brand.replies}`);
    lines.push(`  Gifts shipped: ${brand.giftsShipped}`);
    lines.push(`  Content posted: ${brand.contentPosted}`);
    lines.push(`  Creators added: ${brand.newCreators}`);
    lines.push(`  Took a gift, never posted: ${brand.noContent}`);
    lines.push("");
  }
  lines.push("Sent by Creator Growth Engine every Monday. Figures are the week just finished.");
  return { subject, text: lines.join("\n") };
}
