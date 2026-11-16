import { automationUserId } from "@/lib/automation";
import { allowed } from "@/lib/brand-scope";
import { BRANDS, type BrandId } from "@/lib/brands";
import { db } from "@/lib/db";
import { mcfConfigured } from "@/lib/mcf";
import { previewGiftForAmazon, sendGiftToAmazon } from "@/lib/mcf-flow";

/*
 * Automatic Amazon (MCF) orders, the manager's "like Shopify" request (2026-11-13). Off for every brand
 * until an admin switches it on in Settings, and only for a brand with its SP-API keys. Every job tick it
 * sends the brand's approved gifts that have waited the hold time since approval, oldest first, through
 * exactly the same preview and send as the "Send to Amazon" button, so the same protections hold: one
 * order per gift whatever happens (claim + Amazon's one order per reference), an order Amazon already has
 * (sent with the Amazon file) is only linked, and a lost answer is settled by the hourly check.
 *
 * Safety limits:
 * - the hold after approval, so a person can still catch a mistake before anything is ordered;
 * - at most mcfAutoDailyCap orders a brand in any 24 hours, counting button sends too;
 * - Amazon is asked first; a gift it cannot ship is left for a person with the reason, never retried here;
 * - the first failure stops that brand until the next tick, so a broken key or an Amazon outage cannot
 *   loop through every gift;
 * - a gift with any Amazon note on it (a person's earlier try, an unclear answer) is left for a person.
 */

export type AutoSendSummary = { brands: number; sent: number; leftForPerson: number; failed: number; capped: number };

const DAY_MS = 24 * 60 * 60 * 1000;

/** The brands with automatic orders switched on and the keys to place them. */
export async function autoSendBrands(): Promise<{ brandId: BrandId; holdMinutes: number; dailyCap: number }[]> {
  const configured = BRANDS.map((brand) => brand.id).filter((id) => mcfConfigured(id));
  if (configured.length === 0) return [];
  const settings = await db.brandSettings.findMany({
    where: { brandId: { in: configured }, mcfAutoSend: true },
    select: { brandId: true, mcfAutoHoldMinutes: true, mcfAutoDailyCap: true },
  });
  return settings.map((row) => ({ brandId: row.brandId as BrandId, holdMinutes: row.mcfAutoHoldMinutes, dailyCap: row.mcfAutoDailyCap }));
}

export async function autoSendApprovedGifts(now = new Date(), options: { budgetMs?: number } = {}): Promise<AutoSendSummary> {
  const started = Date.now();
  const budgetMs = options.budgetMs ?? 6_000;
  const brands = await autoSendBrands();
  const summary: AutoSendSummary = { brands: brands.length, sent: 0, leftForPerson: 0, failed: 0, capped: 0 };
  if (brands.length === 0) return summary;
  const automation = await automationUserId();

  for (const brand of brands) {
    const scope = allowed({ id: automation, brandId: brand.brandId, viewBrand: null });
    const sentLastDay = await db.giftOrder.count({
      where: { mcfSentAt: { gte: new Date(now.getTime() - DAY_MS) }, campaignCreator: { campaign: { brandId: brand.brandId } } },
    });
    const room = Math.max(0, brand.dailyCap - sentLastDay);
    const waiting = await db.giftOrder.findMany({
      where: {
        status: "approved",
        mcfSentAt: null,
        mcfError: null,
        approvedAt: { lte: new Date(now.getTime() - brand.holdMinutes * 60_000) },
        campaignCreator: { campaign: { brandId: brand.brandId } },
      },
      orderBy: { approvedAt: "asc" },
      select: { id: true },
      take: room + 1,
    });
    if (waiting.length > room) summary.capped += waiting.length - room;

    for (const { id } of waiting.slice(0, room)) {
      if (Date.now() - started > budgetMs) return summary;
      const preview = await previewGiftForAmazon(id, scope);
      if (!preview.ok) {
        // Amazon unreachable: stop this brand and try again next tick. Anything else is for a person.
        if (/could not be reached/i.test(preview.error)) {
          summary.failed++;
          break;
        }
        await leaveForPerson(id, preview.error);
        summary.leftForPerson++;
        continue;
      }
      if (!preview.alreadyAtAmazon && !preview.preview.fulfillable) {
        const why = preview.preview.reasons.length ? preview.preview.reasons.join(", ") : "no reason given";
        await leaveForPerson(id, `Amazon says it cannot ship this gift (${why}).`);
        summary.leftForPerson++;
        continue;
      }
      const sent = await sendGiftToAmazon(id, scope, automation, now);
      if (sent.ok) {
        summary.sent++;
      } else {
        summary.failed++;
        break;
      }
    }
  }
  return summary;
}

/** Marks a gift so automatic orders skip it; a person sees the reason in the gift drawer and decides. */
async function leaveForPerson(giftId: string, reason: string) {
  await db.giftOrder.updateMany({
    where: { id: giftId, mcfSentAt: null },
    data: { mcfError: `Not sent automatically: ${reason} A person can still press Send to Amazon or use the Amazon file.` },
  });
}
