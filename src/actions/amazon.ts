"use server";

import { revalidatePath } from "next/cache";
import { importAttribution, importBusinessReport, monthFromField, type AttributionImportResult, type BusinessImportResult } from "@/lib/amazon-import";
import { adGroupKey, MAX_REPORT_ROWS, parseAttributionUrl, parseDay, type Grid } from "@/lib/amazon-reports";
import { allowed } from "@/lib/brand-scope";
import { brandName, isBrandId, type BrandId } from "@/lib/brands";
import { db, isUniqueViolation } from "@/lib/db";
import { requireUser } from "@/lib/session";

/** The brand a person may import for: their own, or the one they choose when they have both. */
function importBrand(user: { brandId: string | null }, chosen: unknown): BrandId | null {
  if (user.brandId) return isBrandId(user.brandId) ? user.brandId : null;
  const value = String(chosen ?? "");
  return isBrandId(value) ? value : null;
}

/** The browser sends the file as rows of text; anything else is refused before it reaches the readers, and cut to the readers' row limit plus the header. */
function gridFrom(value: unknown): Grid | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.slice(0, MAX_REPORT_ROWS + 1).map((row) => (Array.isArray(row) ? row.slice(0, 80).map((cell) => String(cell ?? "").slice(0, 500)) : []));
}

/** Shown when a tag belongs to a creator the person may not see, or two people saved it at once. */
const TAG_IN_USE = "This tag is already in use. Each creator needs their own ad group in Amazon Attribution.";

/**
 * Saves the Amazon Attribution tag for a creator in a campaign. The tag is
 * checked (amazon.com, carries maas=..., not a search page), and the ad group
 * name is what Amazon's report will call it, so report rows find the creator.
 */
export async function saveAttributionLink(campaignCreatorId: string, rawUrl: string, rawAdGroup: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  const creator = await db.campaignCreator.findFirst({ where: { id: String(campaignCreatorId ?? ""), ...allowed(user).creators }, select: { id: true, influencerId: true, campaign: { select: { name: true, brandId: true } } } });
  if (!creator) return { ok: false, error: "This creator is not in a campaign you can change." };
  const parsed = parseAttributionUrl(String(rawUrl ?? ""));
  if (!parsed.ok) return parsed;
  const adGroupName = String(rawAdGroup ?? "").trim().slice(0, 200);
  if (!adGroupName) return { ok: false, error: "Type the ad group name exactly as it is in Amazon Attribution." };

  // A tag belongs to the creator it was first saved for, removed or not: it carries that creator's sales
  // history, so it is never moved. Only the same creator may save it again.
  const taken = await db.attributionLink.findUnique({
    where: { maas: parsed.link.maas },
    select: { id: true, campaignCreatorId: true, archived: true, campaignCreator: { select: { campaign: { select: { brandId: true } }, influencer: { select: { name: true } } } } },
  });
  if (taken && taken.campaignCreatorId !== creator.id) {
    // The other creator's name is shown only inside the person's own brand.
    const visible = !taken.archived && allowed(user).includes(taken.campaignCreator.campaign.brandId);
    return { ok: false, error: visible ? `This tag is already saved for ${taken.campaignCreator.influencer.name}. Each creator needs their own ad group in Amazon Attribution.` : TAG_IN_USE };
  }
  // Report rows find links by ad group name, so two live links of one brand may not share one.
  const sameName = await db.attributionLink.findMany({
    where: { archived: false, id: taken ? { not: taken.id } : undefined, campaignCreator: { campaign: { brandId: creator.campaign.brandId } } },
    select: { adGroupName: true },
  });
  if (sameName.some((link) => adGroupKey(link.adGroupName) === adGroupKey(adGroupName))) {
    return { ok: false, error: "Another tracking link already uses this ad group name. Give each creator their own ad group in Amazon Attribution." };
  }
  try {
    await db.$transaction([
      taken
        ? db.attributionLink.update({ where: { id: taken.id }, data: { url: parsed.link.url, asin: parsed.link.asin, adGroupName, archived: false } })
        : db.attributionLink.create({ data: { campaignCreatorId: creator.id, url: parsed.link.url, maas: parsed.link.maas, asin: parsed.link.asin, adGroupName, addedById: user.id } }),
      db.activity.create({
        data: {
          userId: user.id,
          campaignCreatorId: creator.id,
          influencerId: creator.influencerId,
          kind: "note",
          body: `Saved an Amazon tracking link for "${creator.campaign.name}" (ad group "${adGroupName}", ${parsed.link.asin ? `product ${parsed.link.asin}` : parsed.link.store ? "the Store page" : "an Amazon page"}).`,
        },
      }),
    ]);
  } catch (error) {
    // Two saves of the same new tag at once: the second loses to the unique tag.
    if (isUniqueViolation(error)) return { ok: false, error: TAG_IN_USE };
    throw error;
  }
  revalidatePath(`/influencers/${creator.influencerId}`);
  return { ok: true };
}

/** Takes a tracking link off a creator. Its numbers stay in the reports; nothing is deleted. */
export async function archiveAttributionLink(linkId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await requireUser();
  const link = await db.attributionLink.findFirst({ where: { id: String(linkId ?? ""), archived: false, campaignCreator: allowed(user).creators }, select: { id: true, adGroupName: true, campaignCreatorId: true, campaignCreator: { select: { influencerId: true } } } });
  if (!link) return { ok: false, error: "That link is not available." };
  await db.$transaction([
    db.attributionLink.update({ where: { id: link.id }, data: { archived: true } }),
    db.activity.create({ data: { userId: user.id, campaignCreatorId: link.campaignCreatorId, influencerId: link.campaignCreator.influencerId, kind: "note", body: `Removed the Amazon tracking link "${link.adGroupName}" (its numbers are kept).` } }),
  ]);
  revalidatePath(`/influencers/${link.campaignCreator.influencerId}`);
  return { ok: true };
}

/** Uploads an Amazon Attribution report (the browser has turned the CSV or Excel file into rows). */
export async function uploadAttributionReport(input: { brandId?: string; rows: unknown; fileName: string; from?: string; to?: string }): Promise<AttributionImportResult> {
  const user = await requireUser();
  const brandId = importBrand(user, input?.brandId);
  if (!brandId) return { ok: false, error: "Choose the brand this report is for." };
  const grid = gridFrom(input?.rows);
  if (!grid) return { ok: false, error: "The file is empty or could not be read." };
  try {
    const result = await importAttribution({ brandId, grid, fileName: String(input?.fileName ?? "Attribution report"), userId: user.id, from: parseDay(input?.from), to: parseDay(input?.to) });
    if (result.ok) {
      revalidatePath("/reports/amazon");
      revalidatePath("/reports/performance");
    }
    return result;
  } catch (error) {
    console.error("Attribution import failed", error);
    return { ok: false, error: `The report could not be saved for ${brandName(brandId)}. Nothing was changed; try again.` };
  }
}

/** Uploads one month of the Seller Central Business Report. */
export async function uploadBusinessReport(input: { brandId?: string; rows: unknown; fileName: string; month: string }): Promise<BusinessImportResult> {
  const user = await requireUser();
  const brandId = importBrand(user, input?.brandId);
  if (!brandId) return { ok: false, error: "Choose the brand this report is for." };
  const month = monthFromField(String(input?.month ?? ""));
  if (!month) return { ok: false, error: "Choose the month the report covers (it cannot be in the future)." };
  const grid = gridFrom(input?.rows);
  if (!grid) return { ok: false, error: "The file is empty or could not be read." };
  try {
    const result = await importBusinessReport({ brandId, grid, month, fileName: String(input?.fileName ?? "Business Report"), userId: user.id });
    if (result.ok) revalidatePath("/reports/amazon");
    return result;
  } catch (error) {
    console.error("Business Report import failed", error);
    return { ok: false, error: `The report could not be saved for ${brandName(brandId)}. Nothing was changed; try again.` };
  }
}
