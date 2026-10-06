import { openAddress } from "@/lib/address-crypto";
import { allowed } from "@/lib/brand-scope";
import { BRANDS, isBrandId } from "@/lib/brands";
import { db } from "@/lib/db";
import { giftReference } from "@/lib/gifts";
import { requireUser } from "@/lib/session";

// Column names follow Amazon's Multi-Channel Fulfillment bulk order template.
// Check them against the template you download from Seller Central before the
// first upload: Amazon changes it from time to time.
const COLUMNS = [
  "MerchantFulfillmentOrderID",
  "DisplayableOrderID",
  "DisplayableOrderDate",
  "MerchantSKU",
  "Quantity",
  "MerchantFulfillmentOrderItemID",
  "DisplayableOrderComment",
  "DeliverySLA",
  "AddressName",
  "AddressFieldOne",
  "AddressFieldTwo",
  "AddressCity",
  "AddressCountryCode",
  "AddressStateOrRegion",
  "AddressPostalCode",
  "AddressPhoneNumber",
] as const;

const COUNTRY_CODES: Record<string, string> = { "United States": "US", Canada: "CA", "United Kingdom": "GB" };

function cell(value: string | number | null): string {
  let text = value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * Every approved gift order of ONE brand that has not been placed yet, one row each.
 * Each brand ships from its own Amazon account, so a file never mixes brands.
 * Signed-in users only, and only for a brand they work on.
 */
export async function GET(request: Request) {
  const scope = allowed(await requireUser());

  // Someone tied to one brand gets that brand's file; asking for another brand by name finds nothing.
  const asked = new URL(request.url).searchParams.get("brand") ?? scope.brandId ?? "";
  if (!asked) {
    return new Response(`Choose a brand: ${BRANDS.map((brand) => `/orders/export?brand=${brand.id}`).join(" or ")}`, { status: 400 });
  }
  // A brand this person does not work on is not theirs to see: the file does not exist for them.
  if (!isBrandId(asked) || !scope.includes(asked)) return new Response("Not found", { status: 404 });

  const orders = (
    await db.giftOrder.findMany({
      where: { status: "approved", campaignCreator: { campaign: { brandId: asked } } },
      orderBy: { createdAt: "asc" },
      include: { product: { select: { sku: true } } },
    })
  ).map(openAddress);

  const today = new Date().toISOString().slice(0, 10);
  const lines = [COLUMNS.join(",")];
  for (const order of orders) {
    const reference = giftReference(order.id);
    const row: Record<(typeof COLUMNS)[number], string | number | null> = {
      MerchantFulfillmentOrderID: reference,
      DisplayableOrderID: reference,
      DisplayableOrderDate: today,
      MerchantSKU: order.product.sku,
      Quantity: order.quantity,
      MerchantFulfillmentOrderItemID: `${reference}-1`,
      DisplayableOrderComment: "Thank you for collaborating with us.",
      DeliverySLA: "Standard",
      AddressName: order.shipName,
      AddressFieldOne: order.address1,
      AddressFieldTwo: order.address2,
      AddressCity: order.city,
      AddressCountryCode: COUNTRY_CODES[order.country] ?? order.country,
      AddressStateOrRegion: order.state,
      AddressPostalCode: order.postalCode,
      AddressPhoneNumber: order.phone,
    };
    lines.push(COLUMNS.map((column) => cell(row[column])).join(","));
  }

  return new Response(`﻿${lines.join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="amazon-gift-orders-${asked}-${today}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
