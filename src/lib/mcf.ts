import { isBrandId, type BrandId } from "@/lib/brands";

/**
 * Amazon Multi-Channel Fulfillment through the Selling Partner API
 * (Fulfillment Outbound, version 2020-07-01). Server-side only.
 *
 * Switched on per brand, since each brand is its own seller account:
 *   SPAPI_LWA_CLIENT_ID, SPAPI_LWA_CLIENT_SECRET  the private app's credentials
 *   SPAPI_REFRESH_TOKEN_RIDHI, SPAPI_REFRESH_TOKEN_COTTON_PRINT_CLUB
 *                                                 one self-authorised token per seller account
 *   SPAPI_BASE_URL   default https://sellingpartnerapi-na.amazon.com
 *                    (https://sandbox.sellingpartnerapi-na.amazon.com for Amazon's sandbox)
 *   SPAPI_LWA_URL    default https://api.amazon.com/auth/o2/token
 * No AWS signing is needed since October 2023: an LWA access token per request is enough.
 *
 * The portal makes the order id itself (the same CGE-... reference the bulk
 * file uses), because creating an order returns no id. Amazon's answers come
 * back through syncAmazonOrders (src/lib/mcf-flow.ts), which feeds them to
 * the same applyTracking the tracking import uses.
 */
const MARKETPLACE_US = "ATVPDKIKX0DER";
const API_PATH = "/fba/outbound/2020-07-01";
const USER_AGENT = "CreatorGrowthEngine/1.0 (Language=TypeScript; Platform=Netlify)";

const baseUrl = () => (process.env.SPAPI_BASE_URL?.trim() || "https://sellingpartnerapi-na.amazon.com").replace(/\/+$/, "");
const tokenUrl = () => process.env.SPAPI_LWA_URL?.trim() || "https://api.amazon.com/auth/o2/token";
const refreshTokenEnv = (brandId: BrandId) => `SPAPI_REFRESH_TOKEN_${brandId.toUpperCase().replace(/-/g, "_")}`;

/** Whether one-click Amazon orders are switched on for this brand. */
export function mcfConfigured(brandId: string): boolean {
  return Boolean(isBrandId(brandId) && process.env.SPAPI_LWA_CLIENT_ID?.trim() && process.env.SPAPI_LWA_CLIENT_SECRET?.trim() && process.env[refreshTokenEnv(brandId)]?.trim());
}

export class McfError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** Amazon's error code, or "lwa" when the sign-in itself failed (bad or expired keys). */
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

/**
 * Amazon has no order with this reference. Amazon answers that with 404 or,
 * in the 2020-07-01 version, with a 400 "InvalidInput" whose message says the
 * order was not found; a refused sign-in is never read as "no such order".
 */
function isNotFound(error: unknown): boolean {
  if (!(error instanceof McfError) || error.code === "lwa") return false;
  return error.status === 404 || (error.status === 400 && /not\s*found|unable to get order/i.test(error.message));
}

const tokens = new Map<BrandId, { value: string; expiresAt: number }>();

/** An LWA access token for the brand's seller account, reused until five minutes before it expires. */
async function accessToken(brandId: BrandId): Promise<string> {
  const cached = tokens.get(brandId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const response = await fetch(tokenUrl(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: process.env[refreshTokenEnv(brandId)]?.trim() ?? "",
      client_id: process.env.SPAPI_LWA_CLIENT_ID?.trim() ?? "",
      client_secret: process.env.SPAPI_LWA_CLIENT_SECRET?.trim() ?? "",
    }),
    // Short limits throughout: a scheduled run and a button press must both finish well inside the function limit.
    signal: AbortSignal.timeout(6_000),
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!response.ok || !body.access_token) throw new McfError(`Amazon refused the sign-in for ${brandId}: ${body.error_description ?? response.status}. Check the SP-API keys.`, response.status, "lwa");
  tokens.set(brandId, { value: body.access_token, expiresAt: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 300) * 1000 });
  return body.access_token;
}

type AmazonErrors = { errors?: { code?: string; message?: string; details?: string }[] };

/** One SP-API call with the brand's token. */
async function call<T>(brandId: BrandId, method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${baseUrl()}${API_PATH}${path}`, {
    method,
    headers: {
      "x-amz-access-token": await accessToken(brandId),
      "x-amz-date": new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""),
      "user-agent": USER_AGENT,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8_000),
    cache: "no-store",
  });
  const text = await response.text();
  // A gateway page (HTML) instead of JSON is read as "no body", not a crash.
  let parsed: T & AmazonErrors;
  try {
    parsed = (text ? JSON.parse(text) : {}) as T & AmazonErrors;
  } catch {
    parsed = {} as T & AmazonErrors;
  }
  if (!response.ok || (parsed.errors && parsed.errors.length > 0)) {
    const message = parsed.errors?.map((error) => [error.message, error.details].filter(Boolean).join(" ")).join(" ") || `Amazon answered ${response.status}.`;
    throw new McfError(message, response.status, parsed.errors?.[0]?.code ?? null);
  }
  return parsed;
}

export type McfAddress = { name: string; addressLine1: string; addressLine2: string | null; city: string; stateOrRegion: string; postalCode: string; countryCode: string; phone: string | null };
export type McfItem = { sellerSku: string; sellerFulfillmentOrderItemId: string; quantity: number };

/** Amazon wants the two-letter country; the portal stores "United States". */
export function countryCode(country: string): string | null {
  const value = country.trim().toLowerCase();
  if (["us", "usa", "united states", "united states of america", "u.s.", "u.s.a."].includes(value)) return "US";
  return /^[a-z]{2}$/.test(value) ? value.toUpperCase() : null;
}

/** Problems Amazon would reject the order for, checked before anything is sent. */
export function addressProblems(address: Partial<McfAddress>): string[] {
  const problems: string[] = [];
  if (!address.name?.trim()) problems.push("the name");
  if (!address.addressLine1?.trim()) problems.push("the street address");
  if (!address.city?.trim()) problems.push("the city");
  if (!address.postalCode?.trim()) problems.push("the ZIP code");
  if (!address.countryCode) problems.push("the country");
  if (address.countryCode === "US" && !/^[A-Za-z]{2}$/.test(address.stateOrRegion?.trim() ?? "")) problems.push("the two-letter state");
  return problems;
}

export type McfPreview = { fulfillable: boolean; feesUsd: number | null; earliestArrival: string | null; latestArrival: string | null; reasons: string[] };

type PreviewResponse = {
  payload?: {
    fulfillmentPreviews?: {
      shippingSpeedCategory?: string;
      isFulfillable?: boolean;
      estimatedFees?: { name?: string; amount?: { value?: string } }[];
      fulfillmentPreviewShipments?: { earliestArrivalDate?: string; latestArrivalDate?: string }[];
      unfulfillablePreviewItems?: { itemUnfulfillableReasons?: string[] }[];
      orderUnfulfillableReasons?: string[];
    }[];
  };
};

/** What Amazon says it would cost and when it would arrive, before anything is ordered. */
export async function previewOrder(brandId: BrandId, address: McfAddress, items: McfItem[]): Promise<McfPreview> {
  const answer = await call<PreviewResponse>(brandId, "POST", "/fulfillmentOrders/preview", { marketplaceId: MARKETPLACE_US, address, items, shippingSpeedCategories: ["Standard"] });
  const preview = answer.payload?.fulfillmentPreviews?.find((option) => option.shippingSpeedCategory === "Standard") ?? answer.payload?.fulfillmentPreviews?.[0];
  if (!preview) return { fulfillable: false, feesUsd: null, earliestArrival: null, latestArrival: null, reasons: ["Amazon did not offer standard shipping."] };
  const fees = (preview.estimatedFees ?? []).reduce((sum, fee) => sum + Number(fee.amount?.value ?? 0), 0);
  const shipments = preview.fulfillmentPreviewShipments ?? [];
  return {
    fulfillable: preview.isFulfillable === true,
    feesUsd: preview.estimatedFees ? Math.round(fees * 100) / 100 : null,
    earliestArrival: shipments[0]?.earliestArrivalDate ?? null,
    latestArrival: shipments[shipments.length - 1]?.latestArrivalDate ?? null,
    reasons: [...new Set([...(preview.orderUnfulfillableReasons ?? []), ...(preview.unfulfillablePreviewItems ?? []).flatMap((item) => item.itemUnfulfillableReasons ?? [])])],
  };
}

type CreateOrderInput ={ sellerFulfillmentOrderId: string; displayableOrderDate: Date; comment: string; address: McfAddress; items: McfItem[] };

/**
 * Places the order. Amazon answers with an empty body, so the portal's own id
 * is the only key; a lost answer is checked with getOrder before any retry,
 * so a gift is never ordered twice.
 */
export async function createOrder(brandId: BrandId, input: CreateOrderInput): Promise<void> {
  await call(brandId, "POST", "/fulfillmentOrders", {
    marketplaceId: MARKETPLACE_US,
    sellerFulfillmentOrderId: input.sellerFulfillmentOrderId,
    displayableOrderId: input.sellerFulfillmentOrderId,
    displayableOrderDate: input.displayableOrderDate.toISOString(),
    // Printed on the packing slip; Amazon's rule: ISO 8859-1, no double spaces, at most 750 characters.
    displayableOrderComment: input.comment.replace(/[^\x20-\xFF]/g, "").replace(/\s{2,}/g, " ").trim().slice(0, 750) || "Thank you!",
    shippingSpeedCategory: "Standard",
    fulfillmentAction: "Ship",
    fulfillmentPolicy: "FillOrKill",
    destinationAddress: input.address,
    items: input.items,
  });
}

export type McfOrder = {
  status: string;
  packages: { packageNumber: number; carrierCode: string | null; trackingNumber: string | null; shippedAt: string | null }[];
};

type OrderResponse = {
  payload?: {
    fulfillmentOrder?: { fulfillmentOrderStatus?: string };
    fulfillmentShipments?: { fulfillmentShipmentStatus?: string; shippingDate?: string; fulfillmentShipmentPackage?: { packageNumber?: number; carrierCode?: string; trackingNumber?: string }[] }[];
  };
};

/** The order as Amazon sees it, or null when Amazon has no such order. */
export async function getOrder(brandId: BrandId, sellerFulfillmentOrderId: string): Promise<McfOrder | null> {
  try {
    const answer = await call<OrderResponse>(brandId, "GET", `/fulfillmentOrders/${encodeURIComponent(sellerFulfillmentOrderId)}`);
    const shipments = answer.payload?.fulfillmentShipments ?? [];
    return {
      status: answer.payload?.fulfillmentOrder?.fulfillmentOrderStatus ?? "Unknown",
      packages: shipments.flatMap((shipment) =>
        (shipment.fulfillmentShipmentPackage ?? []).flatMap((pack) =>
          pack.packageNumber === undefined ? [] : [{ packageNumber: pack.packageNumber, carrierCode: pack.carrierCode ?? null, trackingNumber: pack.trackingNumber ?? null, shippedAt: shipment.fulfillmentShipmentStatus === "SHIPPED" ? (shipment.shippingDate ?? null) : null }],
        ),
      ),
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Where a package is: Amazon's current status (DELIVERED, IN_TRANSIT, UNDELIVERABLE...) and the public tracking page. */
export async function packageTracking(brandId: BrandId, packageNumber: number): Promise<{ currentStatus: string | null; trackingLink: string | null; deliveredAt: string | null }> {
  const answer = await call<{ payload?: { currentStatus?: string; customerTrackingLink?: string; trackingEvents?: { eventCode?: string; eventDate?: string }[] } }>(brandId, "GET", `/tracking?packageNumber=${packageNumber}`);
  const delivered = (answer.payload?.trackingEvents ?? []).find((event) => event.eventCode === "EVENT_301");
  return { currentStatus: answer.payload?.currentStatus ?? null, trackingLink: answer.payload?.customerTrackingLink ?? null, deliveredAt: delivered?.eventDate ?? null };
}

/** Asks Amazon to cancel. Amazon allows it only before picking starts (Received or Planning); otherwise it refuses. */
export async function cancelOrder(brandId: BrandId, sellerFulfillmentOrderId: string): Promise<void> {
  await call(brandId, "PUT", `/fulfillmentOrders/${encodeURIComponent(sellerFulfillmentOrderId)}/cancel`);
}

/** Amazon's order statuses the portal reads as "this will not ship". */
export const STOPPED_STATUSES = new Set(["Unfulfillable", "Invalid", "Cancelled"]);
/** Package statuses that need a person: the parcel is not coming. */
export const PROBLEM_PACKAGE_STATUSES = new Set(["UNDELIVERABLE", "RETURNING", "RETURNED"]);
/** Package statuses worth a note but often followed by a delivery: the gift stays "shipped". */
export const NOTE_PACKAGE_STATUSES = new Set(["DELIVERY_ATTEMPTED", "CUSTOMER_ACTION", "DELAYED"]);
/** Amazon's statuses while an order can still be cancelled. */
export const CANCELLABLE_STATUSES = new Set(["New", "Received", "Planning"]);
