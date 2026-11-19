import { openAddress } from "@/lib/address-crypto";
import { allowed } from "@/lib/brand-scope";
import { BRANDS, isBrandId } from "@/lib/brands";
import { csvLine, csvResponse } from "@/lib/csv-out";
import { db } from "@/lib/db";
import { isoDay } from "@/lib/format";
import { amazonPhoneNumber, giftReference } from "@/lib/gifts";
import { countryCode } from "@/lib/mcf";
import { requireUser } from "@/lib/session";
import { usStateCode } from "@/lib/us-states";

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
      include: { product: { select: { sku: true } }, lines: { orderBy: { position: "asc" }, select: { quantity: true, product: { select: { sku: true } } } } },
    })
  ).map(openAddress);

  const today = isoDay(new Date());
  const lines = [COLUMNS.join(",")];
  for (const order of orders) {
    const reference = giftReference(order.id);
    // One row per product: Amazon's bulk file groups rows with the same order ID into one order.
    const items = order.lines.length > 0 ? order.lines : [{ product: order.product, quantity: order.quantity }];
    for (const [index, item] of items.entries()) {
    const row: Record<(typeof COLUMNS)[number], string | number | null> = {
      MerchantFulfillmentOrderID: reference,
      DisplayableOrderID: reference,
      DisplayableOrderDate: today,
      MerchantSKU: item.product.sku,
      Quantity: item.quantity,
      MerchantFulfillmentOrderItemID: `${reference}-${index + 1}`,
      DisplayableOrderComment: "Thank you for collaborating with us.",
      DeliverySLA: "Standard",
      AddressName: order.shipName,
      AddressFieldOne: order.address1,
      AddressFieldTwo: order.address2,
      AddressCity: order.city,
      AddressCountryCode: countryCode(order.country) ?? order.country,
      // Two letters for a US state; gifts saved before 19 Nov may hold the full name.
      AddressStateOrRegion: ((countryCode(order.country) ?? order.country) === "US" ? usStateCode(order.state) : null) ?? order.state,
      AddressPostalCode: order.postalCode,
      AddressPhoneNumber: amazonPhoneNumber(order.phone),
    };
    lines.push(csvLine(COLUMNS.map((column) => row[column])));
    }
  }

  return csvResponse(lines, `amazon-gift-orders-${asked}-${today}.csv`);
}
