"use server";

import Papa from "papaparse";
import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity";
import { refreshNextAction } from "@/lib/automation";
import { allowed, type BrandScope } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import { field, type FormState } from "@/lib/form";
import { applyTracking, loadGift } from "@/lib/gift-flow";
import { giftReference } from "@/lib/gifts";
import { requireUser } from "@/lib/session";

const DAY = 24 * 60 * 60 * 1000;

function revalidateGift(where: { campaignId: string; influencerId: string }) {
  revalidatePath("/orders");
  revalidatePath("/today");
  revalidatePath(`/campaigns/${where.campaignId}`);
  revalidatePath(`/influencers/${where.influencerId}`);
}

/** Whether the gift order exists and belongs to a brand inside the scope. */
async function giftInScope(giftId: string, scope: BrandScope): Promise<boolean> {
  return (await db.giftOrder.count({ where: { id: giftId, ...scope.gifts } })) > 0;
}

/** A person approves or cancels a gift order the rules could not approve on their own. */
export async function decideGift(giftId: string, decision: "approve" | "cancel"): Promise<void> {
  const user = await requireUser();
  if (!(await giftInScope(giftId, allowed(user)))) return;
  const gift = await loadGift(giftId);
  if (!gift) return;
  if (decision === "approve" && gift.status !== "needs_approval") return;
  if (decision === "cancel" && (gift.status === "delivered" || gift.status === "cancelled")) return;

  await db.$transaction(async (tx) => {
    await tx.giftOrder.update({
      where: { id: giftId },
      data:
        decision === "approve"
          ? { status: "approved", approvedById: user.id, approvedAt: new Date() }
          : { status: "cancelled" },
    });
    await logActivity(tx, {
      userId: user.id,
      kind: "note",
      campaignCreatorId: gift.campaignCreator.id,
      influencerId: gift.campaignCreator.influencerId,
      body:
        decision === "approve"
          ? `Gift order approved (${gift.product.title}, SKU ${gift.product.sku}).`
          : `Gift order cancelled (${gift.product.title}, SKU ${gift.product.sku}).`,
    });
  });
  await refreshNextAction(gift.campaignCreator.id);
  revalidateGift(gift.campaignCreator);
}

/** One click on the Gift orders screen: the parcel arrived today. */
export async function markDelivered(giftId: string): Promise<void> {
  const user = await requireUser();
  if (!(await giftInScope(giftId, allowed(user)))) return;
  const result = await applyTracking(giftId, { delivered: new Date() }, user.id);
  if (result.error === null) revalidateGift(result);
}

/** The form on a gift order: order number, carrier, tracking, delivered date, or a problem. */
export async function updateGift(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUser();

  const rawDelivered = field(formData, "deliveredAt");
  const delivered = rawDelivered ? new Date(`${rawDelivered}T12:00:00Z`) : null;
  if (delivered && Number.isNaN(delivered.getTime())) return { error: "The delivered date is not valid." };
  if (delivered && delivered.getTime() > Date.now() + DAY) return { error: "The delivered date is in the future." };

  // Another brand's order is reported exactly like one that does not exist.
  if (!(await giftInScope(field(formData, "giftId"), allowed(user)))) return { error: "Gift order not found." };

  const result = await applyTracking(
    field(formData, "giftId"),
    {
      orderNumber: field(formData, "orderNumber") || null,
      carrier: field(formData, "carrier") || null,
      trackingNumber: field(formData, "trackingNumber") || null,
      delivered,
      problem: field(formData, "problem") || null,
    },
    user.id,
  );
  if (result.error !== null) return { error: result.error };
  revalidateGift(result);
  return { message: "Saved." };
}

export type TrackingImportReport = { error?: string; updated?: number; notes?: string[] } | null;

// Amazon's own shipment reports name the same things differently; they are accepted as they are.
const TRACKING_HEADER_ALIASES: Record<string, string> = {
  merchant_order_id: "reference",
  merchant_fulfillment_order_id: "reference",
  displayable_order_id: "reference",
  amazon_order_id: "order_number",
  shipment_date: "shipped_date",
  ship_date: "shipped_date",
  tracking_id: "tracking_number",
};

/**
 * Bulk update from a pasted or uploaded CSV. Columns (any order, extra ones
 * ignored): reference (our CGE-... id) or order_number to find the gift order,
 * then any of order_number, carrier, tracking_number, shipped_date,
 * delivered_date, problem. Amazon's "Fulfilled Shipments" report works as it
 * is: its merchant-order-id is our reference, and it carries the carrier,
 * tracking number and shipment date.
 */
export async function importTracking(_prev: TrackingImportReport, formData: FormData): Promise<TrackingImportReport> {
  const user = await requireUser();

  const file = formData.get("file");
  const text = file instanceof File && file.size > 0 ? await file.text() : field(formData, "pasted");
  if (!text) return { error: "Choose a CSV file or paste the rows." };
  if (text.length > 2_000_000) return { error: "That is too much data for one import." };

  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ""), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => {
      const key = header.trim().toLowerCase().replace(/[\s-]+/g, "_");
      return TRACKING_HEADER_ALIASES[key] ?? key;
    },
  });
  const headers = parsed.meta.fields ?? [];
  if (!headers.includes("reference") && !headers.includes("order_number")) {
    return { error: `The file needs a "reference" or "order_number" column. Found: ${headers.join(", ") || "none"}.` };
  }

  // Rows can only match this person's brand: a reference from the other brand finds nothing.
  const gifts = await db.giftOrder.findMany({
    where: { ...allowed(user).gifts, status: { in: ["approved", "ordered", "shipped", "exception"] } },
    select: { id: true, orderNumber: true },
  });
  const byReference = new Map(gifts.map((gift) => [giftReference(gift.id), gift.id]));
  const byOrderNumber = new Map(gifts.flatMap((gift) => (gift.orderNumber ? [[gift.orderNumber, gift.id] as const] : [])));

  const notes: string[] = [];
  let updated = 0;
  for (const [index, row] of parsed.data.entries()) {
    const cell = (name: string) => (row[name] ?? "").trim();
    const line = index + 2;
    const giftId = byReference.get(cell("reference").toUpperCase()) ?? byOrderNumber.get(cell("order_number"));
    if (!giftId) {
      notes.push(`Row ${line}: no open gift order matches "${cell("reference") || cell("order_number")}".`);
      continue;
    }
    const date = (name: string) => {
      const raw = cell(name);
      if (!raw) return { value: null, bad: false };
      const parsed = new Date(raw.length <= 10 ? `${raw}T12:00:00Z` : raw);
      return { value: Number.isNaN(parsed.getTime()) ? null : parsed, bad: Number.isNaN(parsed.getTime()), raw };
    };
    const delivered = date("delivered_date");
    if (delivered.bad) {
      notes.push(`Row ${line}: delivered date "${delivered.raw}" was not understood.`);
      continue;
    }
    const shipped = date("shipped_date");
    if (shipped.bad) notes.push(`Row ${line}: shipped date "${shipped.raw}" was not understood and was ignored.`);
    const result = await applyTracking(
      giftId,
      {
        orderNumber: cell("order_number") || null,
        carrier: cell("carrier") || null,
        trackingNumber: cell("tracking_number") || null,
        shipped: shipped.value,
        delivered: delivered.value,
        problem: cell("problem") || null,
      },
      user.id,
    );
    if (result.error !== null) notes.push(`Row ${line}: ${result.error}`);
    else {
      updated += 1;
      revalidateGift(result);
    }
  }

  return { updated, notes: notes.slice(0, 50) };
}
