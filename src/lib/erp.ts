import { timingSafeEqual } from "node:crypto";
import { logActivity } from "@/lib/activity";
import { openAddress } from "@/lib/address-crypto";
import type { BrandScope } from "@/lib/brand-scope";
import { brandName } from "@/lib/brands";
import { db } from "@/lib/db";
import { giftReference } from "@/lib/gifts";
import { countryCode } from "@/lib/mcf";
import { usStateCode } from "@/lib/us-states";

/*
 * The company ERP (fabricrush-replenish, built by Umesh): an approved gift goes there as a "Content Creators"
 * order, already filled in, so the team only rechecks the product and sends it to Amazon from the ERP like a
 * Shopify order. Spec: data/claude-handover/erp-content-creators-for-umesh.md.
 *
 * Creator Setu's server sends the order to the ERP's server (its Cloudflare Worker), never through the
 * browser: the address and phone never go in a link. Both sides hold ERP_SECRET; the ERP keys the order on
 * the gift reference, so sending twice never makes two orders. Switched on by two settings:
 *   ERP_ORDERS_URL  the Worker's POST /creator-orders address
 *   ERP_SECRET      the shared key (a Worker secret on the ERP side, a Netlify variable here)
 */

const TIMEOUT_MS = 10_000;

export function erpConfigured(): boolean {
  return Boolean(process.env.ERP_ORDERS_URL?.trim() && process.env.ERP_SECRET?.trim());
}

export type ErpSendResult = { ok: true; url: string; alreadySent: boolean } | { ok: false; error: string };

/** What the ERP is sent for one gift (section 2 of the spec). */
export type ErpOrder = {
  reference: string;
  brand: string;
  campaign: string;
  creator: { name: string; instagram: string | null; email: string | null };
  shipTo: { name: string; line1: string; line2: string | null; city: string; state: string; zip: string; country: string; phone: string | null };
  lines: { sku: string; asin: string | null; title: string; color: string | null; size: string | null; quantity: number; priceUsd: number | null }[];
  approvedAt: string | null;
  note: string | null;
};

async function loadOrder(giftId: string, scope: BrandScope) {
  return db.giftOrder.findFirst({
    where: { id: giftId, ...scope.gifts },
    select: {
      id: true,
      status: true,
      quantity: true,
      approvedAt: true,
      approvalNote: true,
      erpSentAt: true,
      erpUrl: true,
      campaignCreatorId: true,
      shipName: true,
      address1: true,
      address2: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
      phone: true,
      product: { select: { sku: true, asin: true, title: true, color: true, size: true, price: true } },
      // Every product of the gift (from 19 Nov 2026). Older gifts have none and hold one product.
      lines: { orderBy: { position: "asc" }, select: { quantity: true, product: { select: { sku: true, asin: true, title: true, color: true, size: true, price: true } } } },
      campaignCreator: {
        select: {
          campaign: { select: { name: true, brandId: true } },
          influencer: { select: { name: true, email: true, profiles: { where: { platform: "instagram" }, select: { handle: true }, take: 1 } } },
        },
      },
    },
  });
}

/** Builds the order the ERP receives. Exported for the tests. */
export function erpOrderFor(gift: NonNullable<Awaited<ReturnType<typeof loadOrder>>>): ErpOrder {
  const address = openAddress(gift);
  const creator = gift.campaignCreator.influencer;
  return {
    reference: giftReference(gift.id),
    brand: gift.campaignCreator.campaign.brandId,
    campaign: gift.campaignCreator.campaign.name,
    creator: { name: creator.name, instagram: creator.profiles[0]?.handle ?? null, email: creator.email },
    shipTo: {
      name: address.shipName.trim(),
      line1: address.address1.trim(),
      line2: address.address2?.trim() || null,
      city: address.city.trim(),
      // The ERP takes two letters for a US state. Gifts saved before 19 Nov may hold the full name ("Florida").
      state: (countryCode(address.country) === "US" ? usStateCode(address.state) : null) ?? address.state.trim().toUpperCase(),
      // The ERP takes the 5-digit ZIP: "97205-1234" is sent as "97205".
      zip: /^\d{5}-\d{4}$/.test(address.postalCode.trim()) ? address.postalCode.trim().slice(0, 5) : address.postalCode.trim(),
      country: countryCode(address.country) ?? address.country.trim(),
      phone: address.phone?.trim() || null,
    },
    lines: (gift.lines.length > 0 ? gift.lines : [{ product: gift.product, quantity: gift.quantity }]).map(({ product, quantity }) => ({
      sku: product.sku,
      asin: product.asin,
      title: product.title,
      color: product.color,
      size: product.size,
      quantity,
      priceUsd: product.price === null ? null : Number(product.price),
    })),
    approvedAt: gift.approvedAt?.toISOString() ?? null,
    note: gift.approvalNote,
  };
}

type ReplyBody = { ok?: boolean; url?: string; error?: string; code?: number; already?: boolean };
type Reply = { status: number; body: ReplyBody | null };

/**
 * The ERP runs on Google Apps Script (Umesh, 16 Nov), which cannot read request headers and always answers
 * HTTP 200 after one redirect: the key travels in the JSON body as "key", and the outcome is the body's
 * "ok" and "code" (401 wrong key, 400 a field, 503 try again). The Bearer header is sent too, for an ERP
 * server that does read headers. `status` here is the body's code when it has one, else the HTTP status.
 */
async function post(order: ErpOrder): Promise<Reply> {
  try {
    const key = process.env.ERP_SECRET!.trim();
    const response = await fetch(process.env.ERP_ORDERS_URL!.trim(), {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ key, ...order }),
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    const body = (await response.json().catch(() => null)) as ReplyBody | null;
    const status = body && body.ok === false && typeof body.code === "number" ? body.code : response.status;
    return { status, body };
  } catch {
    return { status: 0, body: null };
  }
}

/**
 * Sends an approved gift to the ERP and returns the link to open it there. A gift already sent just returns its
 * link again. One retry when the ERP cannot be reached or fails; the ERP keys on the reference, so a retry can
 * never make a second order.
 */
export async function sendGiftToErp(giftId: string, scope: BrandScope, userId: string, now = new Date()): Promise<ErpSendResult> {
  if (!erpConfigured()) return { ok: false, error: "The ERP connection is not switched on yet." };
  const gift = await loadOrder(giftId, scope);
  if (!gift) return { ok: false, error: "That gift order is not available." };
  if (gift.erpSentAt && gift.erpUrl) return { ok: true, url: gift.erpUrl, alreadySent: true };
  if (gift.status !== "approved") return { ok: false, error: "Only an approved gift that has not been ordered yet can go to the ERP." };

  const order = erpOrderFor(gift);
  let reply = await post(order);
  if (reply.status === 0 || reply.status >= 500) reply = await post(order);

  let error: string | null = null;
  const url = reply.body?.url;
  if (reply.status === 200 && reply.body?.ok && typeof url === "string" && /^https?:\/\//.test(url)) {
    await db.$transaction(async (tx) => {
      await tx.giftOrder.update({ where: { id: gift.id }, data: { erpSentAt: now, erpUrl: url, erpError: null } });
      await logActivity(tx, { userId, kind: "note", campaignCreatorId: gift.campaignCreatorId, body: `Sent the gift to the ERP as ${order.reference} (${brandName(order.brand)}).` });
    });
    return { ok: true, url, alreadySent: false };
  }
  if (reply.status === 0) error = "The ERP could not be reached. Try again in a minute.";
  else if (reply.status === 401 || reply.status === 403) error = "The ERP refused Creator Setu's key. ERP_SECRET must be the same on both sides.";
  else if (reply.status === 400) error = `The ERP could not take this order: ${String(reply.body?.error ?? "a field is missing").slice(0, 200)}`;
  else error = `The ERP did not answer properly (HTTP ${reply.status}). Try again in a minute.`;
  await db.giftOrder.update({ where: { id: gift.id }, data: { erpError: error } });
  return { ok: false, error };
}

/** Checks the ERP's call back to Creator Setu (Authorization: Bearer ERP_SECRET). */
export function erpCallerAllowed(request: Request): boolean {
  const secret = process.env.ERP_SECRET?.trim();
  if (!secret) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The gift behind a reference: CGE- plus the last ten characters of its id, upper case. */
export async function giftIdForReference(reference: string): Promise<string | null> {
  const match = /^CGE-([A-Z0-9]{10})$/.exec(reference.trim().toUpperCase());
  if (!match) return null;
  const gift = await db.giftOrder.findFirst({ where: { id: { endsWith: match[1].toLowerCase() } }, select: { id: true } });
  return gift?.id ?? null;
}
