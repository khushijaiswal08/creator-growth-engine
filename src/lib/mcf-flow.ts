import { openAddress } from "@/lib/address-crypto";
import { automationUserId } from "@/lib/automation";
import type { BrandScope } from "@/lib/brand-scope";
import { BRANDS, brandName, isBrandId, type BrandId } from "@/lib/brands";
import { db } from "@/lib/db";
import { applyTracking } from "@/lib/gift-flow";
import { giftReference } from "@/lib/gifts";
import {
  addressProblems,
  CANCELLABLE_STATUSES,
  cancelOrder,
  countryCode,
  createOrder,
  getOrder,
  mcfConfigured,
  McfError,
  NOTE_PACKAGE_STATUSES,
  packageTracking,
  previewOrder,
  PROBLEM_PACKAGE_STATUSES,
  STOPPED_STATUSES,
  type McfAddress,
  type McfItem,
  type McfOrder,
  type McfPreview,
} from "@/lib/mcf";

/*
 * The gift order side of one-click Amazon MCF. A person presses the button:
 * the gift is checked, Amazon is asked what it would cost and when it would
 * arrive, and only then is the order placed. Nothing is ever ordered by the
 * portal on its own. Amazon's answers (shipped, tracking, delivered,
 * problems) come back through syncAmazonOrders and go through the same
 * applyTracking the tracking import uses, so the creator moves on exactly as
 * with a pasted tracking file.
 */

type GiftForAmazon = { id: string; brandId: BrandId; reference: string; address: McfAddress; items: McfItem[]; createdAt: Date; status: string; mcfSentAt: Date | null };

type Refused = { ok: false; error: string };
/** What Amazon would charge and when the gift would arrive, or why not. */
export type McfPreviewResult = { ok: true; preview: McfPreview; alreadyAtAmazon: boolean } | Refused;
/** The order reference Amazon accepted, or why not. */
export type McfSendResult = { ok: true; reference: string } | Refused;

async function loadForAmazon(giftId: string, scope: BrandScope): Promise<{ ok: true; gift: GiftForAmazon } | Refused> {
  const gift = await db.giftOrder.findFirst({
    where: { id: giftId, ...scope.gifts },
    select: {
      id: true,
      status: true,
      quantity: true,
      createdAt: true,
      mcfSentAt: true,
      shipName: true,
      address1: true,
      address2: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
      phone: true,
      product: { select: { sku: true } },
      campaignCreator: { select: { campaign: { select: { brandId: true } } } },
    },
  });
  if (!gift) return { ok: false, error: "That gift order is not available." };
  const brandId = gift.campaignCreator.campaign.brandId;
  if (!isBrandId(brandId) || !mcfConfigured(brandId)) return { ok: false, error: `One-click Amazon orders are not switched on for ${brandName(brandId)}. Use the Amazon file instead.` };
  const opened = openAddress(gift);
  const address: McfAddress = {
    name: opened.shipName.trim(),
    addressLine1: opened.address1.trim(),
    addressLine2: opened.address2?.trim() || null,
    city: opened.city.trim(),
    stateOrRegion: opened.state.trim().toUpperCase(),
    postalCode: opened.postalCode.trim(),
    countryCode: countryCode(opened.country) ?? "",
    phone: opened.phone?.trim() || null,
  };
  const problems = addressProblems(address);
  if (problems.length > 0) return { ok: false, error: `Amazon needs ${problems.join(", ")} before it can ship. Fix the address in the gift order first.` };
  const reference = giftReference(gift.id);
  return { ok: true, gift: { id: gift.id, brandId, reference, address, items: [{ sellerSku: gift.product.sku, sellerFulfillmentOrderItemId: `${reference}-1`, quantity: gift.quantity }], createdAt: gift.createdAt, status: gift.status, mcfSentAt: gift.mcfSentAt } };
}

const plain = (error: unknown) => (error instanceof McfError ? error.message : "Amazon could not be reached. Try again in a minute.");

/** What Amazon has under this reference: the order, null when it definitely has none, or "unknown" when it could not say. */
async function lookup(brandId: BrandId, reference: string): Promise<McfOrder | null | "unknown"> {
  try {
    return await getOrder(brandId, reference);
  } catch {
    return "unknown";
  }
}

/**
 * Step 1: what Amazon would charge and when it would arrive. Changes nothing.
 * The Amazon file uses the same reference, so Amazon is asked first whether it
 * already has this order (uploaded with the file); then the gift is only
 * linked, unless Amazon stopped that order, which a person must look at.
 */
export async function previewGiftForAmazon(giftId: string, scope: BrandScope): Promise<McfPreviewResult> {
  const loaded = await loadForAmazon(giftId, scope);
  if (!loaded.ok) return loaded;
  if (loaded.gift.status !== "approved" || loaded.gift.mcfSentAt) return { ok: false, error: "Only an approved gift that has not gone to Amazon yet can be sent." };
  try {
    const existing = await getOrder(loaded.gift.brandId, loaded.gift.reference);
    if (existing && STOPPED_STATUSES.has(existing.status)) {
      return { ok: false, error: `Amazon already has an order ${loaded.gift.reference}, and it is ${existing.status.toLowerCase()}. Check it in Seller Central before sending this gift.` };
    }
    if (existing) return { ok: true, alreadyAtAmazon: true, preview: { fulfillable: true, feesUsd: null, earliestArrival: null, latestArrival: null, reasons: [] } };
    return { ok: true, alreadyAtAmazon: false, preview: await previewOrder(loaded.gift.brandId, loaded.gift.address, loaded.gift.items) };
  } catch (error) {
    return { ok: false, error: plain(error) };
  }
}

const UNCONFIRMED = "Not confirmed with Amazon yet. The portal checks again within the hour; do not send it again.";

/**
 * Step 2: places the order. The gift is claimed first (only one press can
 * win), so two clicks or two people can never order it twice. The claim is
 * given back only when Amazon definitely has no order under the reference;
 * when Amazon cannot say, the claim stays and the next check settles it.
 */
export async function sendGiftToAmazon(giftId: string, scope: BrandScope, userId: string, now = new Date()): Promise<McfSendResult> {
  const loaded = await loadForAmazon(giftId, scope);
  if (!loaded.ok) return loaded;
  const { gift } = loaded;
  const claimed = await db.giftOrder.updateMany({ where: { id: gift.id, status: "approved", mcfSentAt: null }, data: { mcfSentAt: now, mcfError: null } });
  if (claimed.count === 0) return { ok: false, error: "This gift has already gone to Amazon, or it is no longer approved." };

  const comment = `A gift from ${brandName(gift.brandId)}. Thank you for creating with us!`;
  let status = "Received";
  try {
    // An order Amazon already has (sent with the Amazon file) is only linked.
    const existing = await getOrder(gift.brandId, gift.reference);
    if (existing) status = existing.status;
    else await createOrder(gift.brandId, { sellerFulfillmentOrderId: gift.reference, displayableOrderDate: gift.createdAt, comment, address: gift.address, items: gift.items });
  } catch (error) {
    // A lost answer may still mean Amazon took the order; a refusal may mean Amazon already has it.
    const after = await lookup(gift.brandId, gift.reference);
    if (after === "unknown") {
      await db.giftOrder.update({ where: { id: gift.id }, data: { mcfError: UNCONFIRMED } });
      return { ok: false, error: `Amazon did not answer clearly (${plain(error)}). ${UNCONFIRMED}` };
    }
    if (after === null) {
      await db.giftOrder.update({ where: { id: gift.id }, data: { mcfSentAt: null, mcfError: plain(error) } });
      return { ok: false, error: `Amazon did not take the order: ${plain(error)}` };
    }
    status = after.status;
  }
  return linkOrder(gift.id, gift.brandId, gift.reference, status, userId, now);
}

/** Records an order Amazon has on the gift. When the gift was cancelled meanwhile, Amazon is asked to cancel at once. */
async function linkOrder(giftId: string, brandId: BrandId, reference: string, status: string, userId: string, now: Date): Promise<McfSendResult> {
  try {
    const applied = await applyTracking(giftId, { orderNumber: reference }, userId);
    if (applied.error) {
      if (/cancelled/i.test(applied.error)) await cancelOrder(brandId, reference).catch(() => undefined);
      await db.giftOrder.update({ where: { id: giftId }, data: { mcfError: applied.error } });
      return { ok: false, error: applied.error };
    }
    await db.giftOrder.update({ where: { id: giftId }, data: { mcfStatus: status, mcfCheckedAt: now, mcfError: null } });
    return { ok: true, reference };
  } catch {
    await db.giftOrder.update({ where: { id: giftId }, data: { mcfError: UNCONFIRMED } }).catch(() => undefined);
    return { ok: false, error: UNCONFIRMED };
  }
}

/**
 * Before a gift is cancelled in the portal, Amazon is asked what it has under
 * the gift's reference, whether the gift went with the button or the Amazon
 * file. Nothing there, or an order Amazon already stopped: the portal may
 * cancel. Still waiting: Amazon cancels it first. Already packing or shipped:
 * refused, so the portal never says "cancelled" for a parcel on its way; only
 * a gift already marked as a problem (a returned parcel, say) can be closed.
 * Returns what the gift's claim looked like, so the cancel can be written
 * only if nobody sent it in the meantime.
 */
export async function cancelAtAmazon(giftId: string): Promise<{ ok: true; sentAt: Date | null } | Refused> {
  const gift = await db.giftOrder.findUnique({ where: { id: giftId }, select: { id: true, status: true, mcfSentAt: true, campaignCreator: { select: { campaign: { select: { brandId: true } } } } } });
  if (!gift) return { ok: false, error: "That gift order is not available." };
  const brandId = gift.campaignCreator.campaign.brandId;
  if (!isBrandId(brandId) || !mcfConfigured(brandId)) {
    if (gift.mcfSentAt) return { ok: false, error: "This order went to Amazon, and the Amazon keys are not set, so it cannot be cancelled from here. Cancel it in Seller Central." };
    return { ok: true, sentAt: null };
  }
  const reference = giftReference(gift.id);
  const order = await lookup(brandId, reference);
  if (order === "unknown") return { ok: false, error: "Amazon could not be reached to check this order. Try again in a minute." };
  if (order === null || STOPPED_STATUSES.has(order.status)) return { ok: true, sentAt: gift.mcfSentAt };
  if (CANCELLABLE_STATUSES.has(order.status)) {
    try {
      await cancelOrder(brandId, reference);
      await db.giftOrder.update({ where: { id: gift.id }, data: { mcfStatus: "Cancelled" } });
      return { ok: true, sentAt: gift.mcfSentAt };
    } catch (error) {
      return { ok: false, error: `Amazon would not cancel it: ${plain(error)}` };
    }
  }
  if (gift.status === "exception") return { ok: true, sentAt: gift.mcfSentAt };
  return { ok: false, error: `Amazon is already ${order.status === "Processing" ? "packing" : "shipping"} ${reference}, so it cannot be cancelled. If it comes back, it shows here as a problem.` };
}

export type SyncSummary = { checked: number; linked: number; released: number; shipped: number; delivered: number; problems: number; failed: number };

/** A claim older than this with no order number is a send that never finished (a send gives up within half a minute). */
const STALE_CLAIM_MS = 2 * 60 * 1000;

/**
 * Reads back what Amazon did with the gifts the portal sent: the order's
 * status, its packages and their tracking, and whether each parcel arrived.
 * Every change goes through applyTracking, so "shipped" and "delivered" move
 * the creator on. A problem (an order Amazon stopped, a parcel coming back)
 * is raised only when Amazon's status changes, so a person's fix is not
 * undone an hour later. Sends that never finished are settled first. Stops
 * starting new gifts once its time budget is spent; the oldest-checked come
 * first, so the rest are seen on the next run.
 */
export async function syncAmazonOrders(now = new Date(), options: { brandIds?: string[]; budgetMs?: number; firstGiftId?: string | null } = {}): Promise<SyncSummary> {
  const summary: SyncSummary = { checked: 0, linked: 0, released: 0, shipped: 0, delivered: 0, problems: 0, failed: 0 };
  const brands = BRANDS.map((brand) => brand.id).filter((id) => mcfConfigured(id) && (!options.brandIds || options.brandIds.includes(id)));
  if (brands.length === 0) return summary;
  const started = Date.now();
  const outOfTime = () => Date.now() - started > (options.budgetMs ?? 5_000);
  const inBrands = { campaignCreator: { campaign: { brandId: { in: brands } } } };
  const actor = await automationUserId();

  // 1. Sends cut off after the claim: linked when Amazon has the order, freed when it definitely has not.
  const stale = await db.giftOrder.findMany({
    where: { ...inBrands, status: "approved", orderNumber: null, mcfSentAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) } },
    take: 10,
    select: { id: true, campaignCreator: { select: { campaign: { select: { brandId: true } } } } },
  });
  for (const gift of stale) {
    if (outOfTime()) return summary;
    const brandId = gift.campaignCreator.campaign.brandId as BrandId;
    const reference = giftReference(gift.id);
    const order = await lookup(brandId, reference);
    if (order === "unknown") continue;
    if (order === null) {
      await db.giftOrder.update({ where: { id: gift.id }, data: { mcfSentAt: null, mcfError: "Amazon never received this order. It can be sent again." } });
      summary.released += 1;
    } else if ((await linkOrder(gift.id, brandId, reference, order.status, actor, now)).ok) summary.linked += 1;
  }

  // 2. Orders on their way, oldest-checked first; the gift someone is looking at goes first.
  const onTheWay = { ...inBrands, mcfSentAt: { not: null }, status: { in: ["ordered" as const, "shipped" as const] } };
  const fields = { id: true, status: true, mcfStatus: true, mcfPackageNumber: true, mcfPackageStatus: true, campaignCreator: { select: { campaign: { select: { brandId: true } } } } } as const;
  const first = options.firstGiftId ? await db.giftOrder.findMany({ where: { ...onTheWay, id: options.firstGiftId }, select: fields }) : [];
  const rest = await db.giftOrder.findMany({
    where: { ...onTheWay, ...(options.firstGiftId ? { id: { not: options.firstGiftId } } : {}) },
    orderBy: [{ mcfCheckedAt: { sort: "asc", nulls: "first" } }],
    take: 25,
    select: fields,
  });
  const open = [...first, ...rest];

  for (const gift of open) {
    if (outOfTime()) break;
    const brandId = gift.campaignCreator.campaign.brandId as BrandId;
    summary.checked += 1;
    const reference = giftReference(gift.id);
    try {
      const order = await getOrder(brandId, reference);
      if (!order) {
        await db.giftOrder.update({ where: { id: gift.id }, data: { mcfCheckedAt: now, mcfError: "Amazon has no order with this reference." } });
        continue;
      }
      let packageNumber = gift.mcfPackageNumber;
      let packageStatus = gift.mcfPackageStatus;
      let trackingLink: string | null = null;
      let note: string | null = null;
      if (STOPPED_STATUSES.has(order.status)) {
        if (order.status !== gift.mcfStatus) {
          await applyTracking(gift.id, { problem: `Amazon stopped the order (${order.status}). Check it in Seller Central.` }, actor);
          summary.problems += 1;
        }
      } else {
        const shipped = order.packages.find((pack) => pack.trackingNumber);
        if (shipped && gift.status === "ordered") {
          await applyTracking(gift.id, { carrier: shipped.carrierCode, trackingNumber: shipped.trackingNumber, shipped: shipped.shippedAt ? new Date(shipped.shippedAt) : now }, actor);
          summary.shipped += 1;
        }
        packageNumber = shipped?.packageNumber ?? packageNumber;
        if (packageNumber !== null && shipped && !outOfTime()) {
          const tracking = await packageTracking(brandId, packageNumber);
          trackingLink = tracking.trackingLink;
          const changed = tracking.currentStatus !== gift.mcfPackageStatus;
          packageStatus = tracking.currentStatus ?? packageStatus;
          if (tracking.currentStatus === "DELIVERED") {
            await applyTracking(gift.id, { delivered: tracking.deliveredAt ? new Date(tracking.deliveredAt) : now }, actor);
            summary.delivered += 1;
          } else if (changed && tracking.currentStatus && PROBLEM_PACKAGE_STATUSES.has(tracking.currentStatus)) {
            await applyTracking(gift.id, { problem: `The carrier reports ${tracking.currentStatus.toLowerCase().replace(/_/g, " ")}.` }, actor);
            summary.problems += 1;
          } else if (tracking.currentStatus && NOTE_PACKAGE_STATUSES.has(tracking.currentStatus)) {
            // Often followed by a delivery: a note for the team, and the gift stays "shipped".
            note = `In transit: ${tracking.currentStatus.toLowerCase().replace(/_/g, " ")}`;
          }
        }
      }
      await db.giftOrder.update({
        where: { id: gift.id },
        data: { mcfStatus: order.status, mcfCheckedAt: now, mcfPackageNumber: packageNumber, mcfPackageStatus: packageStatus, mcfError: null, ...(trackingLink ? { trackingLink } : {}), ...(note ? { trackingStatus: note } : {}) },
      });
    } catch (error) {
      summary.failed += 1;
      await db.giftOrder.update({ where: { id: gift.id }, data: { mcfCheckedAt: now, mcfError: plain(error) } });
      // Amazon is busy: stop for this run rather than hammer it.
      if (error instanceof McfError && error.status === 429) break;
    }
  }
  return summary;
}
