import { automationUserId } from "@/lib/automation";
import { db } from "@/lib/db";
import { erpCallerAllowed, giftIdForReference } from "@/lib/erp";
import { applyTracking } from "@/lib/gift-flow";

export const dynamic = "force-dynamic";

/**
 * The ERP tells Creator Setu what happened to a gift it took (section 3 of the ERP spec):
 *   POST /api/erp/orders/CGE-XXXXXXXXXX   Authorization: Bearer ERP_SECRET
 *   { status: "sent_to_amazon" | "shipped" | "delivered" | "cancelled", amazonOrderId?, carrier?, tracking?, at? }
 * Sent, shipped and delivered go through the same applyTracking as a pasted tracking file, so the creator moves
 * on exactly as usual. "cancelled" never cancels the gift here: it is left for a person, with a note.
 */
const STATUSES = new Set(["sent_to_amazon", "shipped", "delivered", "cancelled"]);

export async function POST(request: Request, { params }: { params: Promise<{ reference: string }> }) {
  if (!erpCallerAllowed(request)) return Response.json({ ok: false, error: "Not authorised." }, { status: 401 });
  const { reference } = await params;
  const giftId = await giftIdForReference(reference);
  if (!giftId) return Response.json({ ok: false, error: "No gift order with that reference." }, { status: 404 });

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const status = typeof body?.status === "string" ? body.status : "";
  if (!STATUSES.has(status)) return Response.json({ ok: false, error: "status must be sent_to_amazon, shipped, delivered or cancelled." }, { status: 400 });
  const text = (value: unknown, max = 120) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null);
  const at = text(body?.at) ? new Date(String(body?.at)) : new Date();
  if (Number.isNaN(at.getTime())) return Response.json({ ok: false, error: "at must be a date and time." }, { status: 400 });

  if (status === "cancelled") {
    await db.giftOrder.update({ where: { id: giftId }, data: { erpError: `The ERP says this order was cancelled (${at.toISOString().slice(0, 10)}). Check it and cancel the gift here if right.` } });
    return Response.json({ ok: true, reference: reference.toUpperCase(), note: "left for a person" });
  }

  const orderNumber = text(body?.amazonOrderId) ?? reference.toUpperCase();
  const update =
    status === "sent_to_amazon"
      ? { orderNumber }
      : status === "shipped"
        ? { orderNumber, carrier: text(body?.carrier, 40), trackingNumber: text(body?.tracking, 80), shipped: at }
        : { orderNumber, carrier: text(body?.carrier, 40), trackingNumber: text(body?.tracking, 80), delivered: at };
  const result = await applyTracking(giftId, update, await automationUserId());
  if (result.error) return Response.json({ ok: false, error: result.error }, { status: 409 });
  return Response.json({ ok: true, reference: reference.toUpperCase() });
}
