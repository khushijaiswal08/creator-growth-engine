import { logActivity } from "@/lib/activity";
import { refreshNextAction } from "@/lib/automation";
import { db } from "@/lib/db";
import { CREATOR_STATUS_LABELS } from "@/lib/status";

const DAY = 24 * 60 * 60 * 1000;

export async function loadGift(id: string) {
  return db.giftOrder.findUnique({
    where: { id },
    include: {
      product: { select: { title: true, sku: true } },
      campaignCreator: {
        select: { id: true, status: true, influencerId: true, campaignId: true, campaign: { select: { contentDueDays: true } } },
      },
    },
  });
}

export type TrackingUpdate = {
  orderNumber?: string | null;
  carrier?: string | null;
  trackingNumber?: string | null;
  /** When Amazon shipped it, if the file says; otherwise the day the tracking number arrives here. */
  shipped?: Date | null;
  delivered?: Date | null;
  problem?: string | null;
};

export type TrackingResult = { error: string } | { error: null; campaignId: string; influencerId: string };

/**
 * Applies order and tracking details to one gift order and moves the creator on:
 *
 *   order number    -> Ordered
 *   tracking number -> Shipped, creator becomes "Product shipped"
 *   delivered date  -> Delivered, creator becomes "Content expected" and the
 *                      content clock starts from that date, not from dispatch
 */
export async function applyTracking(giftId: string, update: TrackingUpdate, userId: string): Promise<TrackingResult> {
  const gift = await loadGift(giftId);
  if (!gift) return { error: "Gift order not found." };
  if (gift.status === "cancelled") return { error: "That gift order was cancelled." };
  if (gift.status === "needs_approval") return { error: "Approve the gift order first." };

  const orderNumber = update.orderNumber ?? gift.orderNumber;
  const trackingNumber = update.trackingNumber ?? gift.trackingNumber;
  const carrier = update.carrier ?? gift.carrier;
  const deliveredAt = update.delivered ?? gift.deliveredAt;
  const now = new Date();

  const status = update.problem
    ? "exception"
    : deliveredAt
      ? "delivered"
      : trackingNumber
        ? "shipped"
        : orderNumber
          ? "ordered"
          : gift.status;
  const shippedAt = gift.shippedAt ?? update.shipped ?? (trackingNumber || deliveredAt ? now : null);

  const creator = gift.campaignCreator;
  const where = { campaignId: creator.campaignId, influencerId: creator.influencerId };
  // Only move the creator forward along the shipping path; never pull back someone already further on.
  const creatorStatus =
    status === "delivered" && ["address_collected", "product_shipped"].includes(creator.status)
      ? ("content_expected" as const)
      : status === "shipped" && creator.status === "address_collected"
        ? ("product_shipped" as const)
        : null;

  const notes = [
    update.orderNumber && update.orderNumber !== gift.orderNumber ? `Amazon order ${update.orderNumber}` : "",
    update.trackingNumber && update.trackingNumber !== gift.trackingNumber
      ? `tracking ${[carrier, update.trackingNumber].filter(Boolean).join(" ")}`
      : "",
    update.delivered && !gift.deliveredAt ? `delivered ${update.delivered.toISOString().slice(0, 10)}` : "",
    update.problem ? `problem: ${update.problem}` : "",
  ].filter(Boolean);
  if (notes.length === 0 && status === gift.status) return { error: null, ...where };

  await db.$transaction(async (tx) => {
    await tx.giftOrder.update({
      where: { id: giftId },
      data: {
        status,
        orderNumber,
        carrier,
        trackingNumber,
        shippedAt,
        deliveredAt,
        trackingStatus:
          update.problem ?? (status === "delivered" ? "Delivered" : status === "shipped" ? "In transit" : gift.trackingStatus),
      },
    });
    if (creatorStatus) {
      await tx.campaignCreator.update({
        where: { id: creator.id },
        data: {
          status: creatorStatus,
          contentDueAt:
            creatorStatus === "content_expected" && deliveredAt
              ? new Date(deliveredAt.getTime() + creator.campaign.contentDueDays * DAY)
              : undefined,
        },
      });
      await logActivity(tx, {
        userId,
        kind: "status_change",
        campaignCreatorId: creator.id,
        influencerId: creator.influencerId,
        body: `Status changed from ${CREATOR_STATUS_LABELS[creator.status]} to ${CREATOR_STATUS_LABELS[creatorStatus]}.`,
      });
    }
    await logActivity(tx, {
      userId,
      kind: "note",
      campaignCreatorId: creator.id,
      influencerId: creator.influencerId,
      body: `Gift order updated: ${notes.join(", ") || status}.`,
    });
  });
  await refreshNextAction(creator.id, now);
  return { error: null, ...where };
}
