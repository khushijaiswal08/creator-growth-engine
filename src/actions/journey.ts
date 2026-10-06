"use server";

import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity";
import { refreshNextAction, runAutomations } from "@/lib/automation";
import { allowed } from "@/lib/brand-scope";
import { brandName, isBrandId } from "@/lib/brands";
import { db } from "@/lib/db";
import { field, type FormState } from "@/lib/form";
import { isFiltered, isOfferStatus, OFFER_STATUS_LABELS, productListWhere } from "@/lib/product-list";
import { importAmazonListings, importProducts, type ProductImportReport } from "@/lib/products";
import { requireUser } from "@/lib/session";
import { CREATOR_STATUS_LABELS } from "@/lib/status";

/* ----------------------------------------------------------------- products */

/**
 * Admin only. Adds or refreshes the product list for one brand.
 *
 * Two kinds of upload arrive here. A CSV or Amazon text file (a product list
 * or a stock refresh) comes as the file itself. Amazon's Category Listing
 * Report is a large Excel workbook, so the browser opens it and sends only the
 * columns the portal uses, as "listings".
 */
export async function uploadProducts(_prev: ProductImportReport, formData: FormData): Promise<ProductImportReport> {
  const user = await requireUser();
  if (user.role !== "admin") return { error: "Only an admin can change the product list." };

  const brandId = field(formData, "brandId");
  if (!isBrandId(brandId)) return { error: "Choose a brand." };

  try {
    const listings = formData.get("listings");
    let report: ProductImportReport;
    if (typeof listings === "string" && listings !== "") {
      let rows: unknown;
      try {
        rows = JSON.parse(listings);
      } catch {
        return { error: "The report could not be read. Try uploading it again." };
      }
      const fileName = field(formData, "fileName").slice(0, 120) || "Amazon listing report";
      report = await importAmazonListings(rows, brandId, { userId: user.id, fileName });
    } else {
      const file = formData.get("file");
      if (!(file instanceof File) || file.size === 0) return { error: "Choose a file." };
      if (/\.xlsx?$/i.test(file.name)) return { error: "The Excel file could not be opened in the browser. Reload the page and try again." };
      if (file.size > 3 * 1024 * 1024) return { error: "The file is larger than 3 MB." };
      report = await importProducts(await file.text(), brandId, { userId: user.id, fileName: file.name.slice(0, 120) });
    }
    revalidatePath("/admin/products");
    return report;
  } catch (error) {
    // The import is written in one transaction, so a failure leaves the list as it was.
    console.error("Product import failed", error);
    return { error: "The import failed and nothing was changed. Please try again." };
  }
}

/** Admin only. Switches one product on or off for creators. */
export async function setOffered(formData: FormData): Promise<void> {
  const user = await requireUser();
  if (user.role !== "admin") return;

  const offered = field(formData, "offered") === "yes";
  const product = await db.product.findUnique({
    where: { id: field(formData, "productId") },
    select: { id: true, sku: true, title: true, color: true, size: true, giftable: true },
  });
  if (!product || product.giftable === offered) return;

  const label = [product.title, product.color, product.size].filter(Boolean).join(", ");
  await db.$transaction([
    db.product.update({ where: { id: product.id }, data: { giftable: offered } }),
    logActivity(db, {
      userId: user.id,
      kind: "note",
      body: offered
        ? `Product ${label} (SKU ${product.sku}) is offered to creators again.`
        : `Product ${label} (SKU ${product.sku}) is no longer offered to creators.`,
    }),
  ]);
  revalidatePath("/admin/products");
}

/** Admin only. Switches every product matching the Products screen's current search and filters on or off for creators. */
export async function setOfferedForList(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();
  if (user.role !== "admin") return { error: "Only an admin can change the product list." };

  const offered = field(formData, "offered") === "yes";
  const filter = { q: field(formData, "q"), brand: field(formData, "brand"), view: field(formData, "view") };
  // Without a search or filter this would switch the whole catalogue at once.
  if (!isFiltered(filter)) return { error: "Search or filter the list first." };

  const narrowedTo = [
    filter.q ? `search "${filter.q}"` : null,
    isBrandId(filter.brand) ? brandName(filter.brand) : null,
    isOfferStatus(filter.view) ? OFFER_STATUS_LABELS[filter.view] : null,
  ]
    .filter(Boolean)
    .join(", ");

  const changed = await db.$transaction(async (tx) => {
    const result = await tx.product.updateMany({ where: { AND: [productListWhere(filter), { giftable: !offered }] }, data: { giftable: offered } });
    if (result.count > 0) {
      await logActivity(tx, {
        userId: user.id,
        kind: "note",
        body: `${result.count} products ${offered ? "switched on for" : "switched off for"} creators (list narrowed to: ${narrowedTo}).`,
      });
    }
    return result.count;
  });

  revalidatePath("/admin/products");
  if (changed === 0) return { message: offered ? "These were all offered already." : "None of these were being offered." };
  return { message: offered ? `${changed} products are now offered to creators.` : `${changed} products are no longer offered to creators.` };
}

/* ------------------------------------------------------- campaign automation */

const TIMING_FIELDS = [
  ["followUpAfterDays", 1, 60],
  ["maxFollowUps", 0, 5],
  ["closeAfterDays", 1, 90],
  ["selectionWaitDays", 1, 60],
  ["deliveryWaitDays", 1, 60],
  ["contentReminderDays", 1, 90],
  ["contentDueDays", 1, 180],
  ["noContentAfterDays", 1, 365],
] as const;

/** Admin only. The waiting periods the automation uses for this campaign, and which product types creators may pick. */
export async function saveCampaignAutomation(_prev: FormState, formData: FormData): Promise<FormState> {
  // Anyone may change the timers of their own brand's campaigns; the brand scope below decides which those are.
  const user = await requireUser();

  const campaignId = field(formData, "campaignId");
  const data: Record<string, number | string[]> = {};
  for (const [name, min, max] of TIMING_FIELDS) {
    const value = Number(field(formData, name));
    if (!Number.isInteger(value) || value < min || value > max) {
      return { error: `Each waiting period must be a whole number in its allowed range (${name}: ${min} to ${max}).` };
    }
    data[name] = value;
  }
  data.giftArticles = formData.getAll("giftArticles").filter((value): value is string => typeof value === "string" && value !== "");

  const campaign = await db.campaign.findFirst({ where: { id: campaignId, ...allowed(user).campaigns }, select: { name: true } });
  if (!campaign) return { error: "This campaign no longer exists." };

  await db.$transaction(async (tx) => {
    await tx.campaign.update({ where: { id: campaignId }, data });
    await logActivity(tx, { userId: user.id, kind: "note", body: `Changed automation settings for "${campaign.name}".` });
  });
  // New timings can change who is due; apply them straight away.
  await runAutomations("manual");

  revalidatePath(`/campaigns/${campaignId}`);
  revalidatePath("/settings");
  revalidatePath("/today");
  return { message: "Saved, and Today was refreshed." };
}

/** Runs the automation now. Any signed-in user may ask for a refresh; it only applies the timer rules. */
export async function runAutomationsNow(): Promise<FormState> {
  await requireUser();
  const summary = await runAutomations("manual");
  revalidatePath("/today");
  revalidatePath("/today");
  return {
    message: `Checked ${summary.checked} creators: ${summary.followUpsDue} follow-ups now due, ${summary.closedNoReply} closed as no reply, ${summary.closedNoContent} closed as no content delivered, ${summary.nextActionsUpdated} next actions updated.`,
  };
}

/* ------------------------------------------------------------------ content */

const FORMATS = ["reel", "story", "post", "carousel", "video", "short", "pin"] as const;

/** Records a live post. The creator becomes "Content posted"; a person then checks it and marks it completed. */
export async function addPost(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();

  const campaignCreatorId = field(formData, "campaignCreatorId");
  const rawUrl = field(formData, "url");
  const format = field(formData, "format");
  let url: URL;
  try {
    url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
  } catch {
    return { error: "Paste the full link to the post." };
  }
  if (!(FORMATS as readonly string[]).includes(format)) return { error: "Choose what kind of post it is." };

  const creator = await db.campaignCreator.findFirst({
    where: { id: campaignCreatorId, ...allowed(user).creators },
    select: { status: true, influencerId: true, campaignId: true, influencer: { select: { profiles: { select: { id: true, platform: true } } } } },
  });
  if (!creator) return { error: "This creator is no longer in the campaign." };
  const profile =
    creator.influencer.profiles.find((p) => url.hostname.includes(p.platform === "youtube" ? "youtu" : p.platform)) ??
    creator.influencer.profiles[0];
  if (!profile) return { error: "This creator has no profile to attach the post to." };

  const checked = (name: string) => formData.get(name) === "on";
  const moveOn = creator.status !== "content_posted" && creator.status !== "completed";

  try {
    await db.$transaction(async (tx) => {
      await tx.post.create({
        data: {
          campaignCreatorId,
          socialProfileId: profile.id,
          url: url.toString(),
          format,
          postedAt: new Date(),
          mentionsBrand: checked("mentionsBrand"),
          hasDisclosure: checked("hasDisclosure"),
          productShown: checked("productShown"),
          collabInvite: checked("collabInvite"),
        },
      });
      if (moveOn) await tx.campaignCreator.update({ where: { id: campaignCreatorId }, data: { status: "content_posted" } });
      await logActivity(tx, {
        userId: user.id,
        kind: moveOn ? "status_change" : "note",
        campaignCreatorId,
        influencerId: creator.influencerId,
        body: moveOn
          ? `Status changed from ${CREATOR_STATUS_LABELS[creator.status]} to ${CREATOR_STATUS_LABELS.content_posted}: ${format} posted.`
          : `Another ${format} recorded.`,
      });
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      return { error: "That post link is already recorded." };
    }
    throw error;
  }
  await refreshNextAction(campaignCreatorId);

  revalidatePath(`/influencers/${creator.influencerId}`);
  revalidatePath(`/campaigns/${creator.campaignId}`);
  revalidatePath("/today");
  return { message: "Post recorded." };
}
