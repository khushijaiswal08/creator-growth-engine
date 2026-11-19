import type { GiftOrderStatus } from "@prisma/client";
import { ClipboardPaste, Download } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { GiftCreatorButton } from "@/components/gift-entry";
import { GiftsTable, type GiftRow } from "@/components/gifts-table";
import { TrackingImportForm } from "@/components/journey-forms";
import { PageHeader } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { openAddress } from "@/lib/address-crypto";
import { brandsIn, viewed } from "@/lib/brand-scope";
import { brandShortName, brandsLabel } from "@/lib/brands";
import { db } from "@/lib/db";
import { approvalChecksForOrders, GIFT_STATUS_LABELS, GIFT_STATUSES, giftReference, OPEN_GIFT_STATUSES } from "@/lib/gifts";
import { erpConfigured } from "@/lib/erp";
import { mcfConfigured } from "@/lib/mcf";
import { describeProduct } from "@/lib/product-list";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Gifts" };

const PAGE_SIZE = 50;

// The tab words, shorter than the status labels where the context makes them clear.
const TAB_LABELS: Record<GiftOrderStatus, string> = {
  needs_approval: "Needs approval",
  approved: "To order",
  ordered: "Ordered",
  shipped: "Shipped",
  delivered: "Delivered",
  exception: "Problems",
  cancelled: "Cancelled",
};

const SORTS = { newest: "Newest first", oldest: "Oldest first", status: "By status" } as const;
type Sort = keyof typeof SORTS;

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ status?: string; sort?: string }> }) {
  const view = viewed(await requireUser());
  const params = await searchParams;
  const raw = params.status ?? "";
  const filter = GIFT_STATUSES.includes(raw as GiftOrderStatus) ? (raw as GiftOrderStatus) : null;
  const sort: Sort = params.sort === "oldest" || params.sort === "status" ? params.sort : "newest";

  const [stored, counts, campaignsDelivered, toOrderCounts, giftCampaigns] = await Promise.all([
    db.giftOrder.findMany({
      where: { ...view.gifts, status: filter ?? { not: "cancelled" } },
      orderBy: sort === "status" ? [{ status: "asc" }, { createdAt: "desc" }] : { createdAt: sort === "oldest" ? "asc" : "desc" },
      take: PAGE_SIZE,
      include: {
        product: { select: { title: true, color: true, size: true, sku: true, amazonUrl: true, price: true, imageUrl: true, stock: true } },
        // Line 1 is the product above; the rest are listed in the drawer.
        lines: { where: { position: { gt: 0 } }, orderBy: { position: "asc" }, select: { quantity: true, product: { select: { title: true, color: true, size: true, sku: true, price: true } } } },
        campaignCreator: {
          select: { id: true, influencerId: true, collaborationType: true, approvedFee: true, campaign: { select: { id: true, name: true, brandId: true, arrivalCheckDays: true } }, influencer: { select: { id: true, name: true } } },
        },
      },
    }),
    db.giftOrder.groupBy({ by: ["status"], where: view.gifts, _count: { _all: true } }),
    // Campaigns that have had a delivery already: delivering a gift in any other campaign is its first.
    db.campaign.findMany({ where: { ...view.campaigns, creators: { some: { giftOrders: { some: { deliveredAt: { not: null } } } } } }, select: { id: true } }),
    // Each brand ships from its own Amazon account, so there is one order file per brand.
    Promise.all(
      brandsIn(view).map(async (brand) => ({
        brand,
        count: await db.giftOrder.count({ where: { status: "approved", campaignCreator: { campaign: { brandId: brand.id } } } }),
      })),
    ),
    // "Gift a creator": the open campaigns of the brands this person is looking at.
    db.campaign.findMany({ where: { ...view.campaigns, status: { not: "archived" } }, orderBy: { createdAt: "desc" }, select: { id: true, name: true, brandId: true } }),
  ]);
  const campaignsWithDelivery = new Set(campaignsDelivered.map((row) => row.id));
  const toOrder = toOrderCounts.filter((row) => row.count > 0);
  const countOf = new Map(counts.map((row) => [row.status, row._count._all]));
  const openCount = GIFT_STATUSES.filter((status) => OPEN_GIFT_STATUSES.has(status)).reduce((sum, status) => sum + (countOf.get(status) ?? 0), 0);

  // Addresses are encrypted at rest; only this signed-in, brand-scoped page reads them.
  // Open orders also carry the rules they passed or failed, so the drawer can show them.
  const opened = stored.map(openAddress);
  const checks = await approvalChecksForOrders(
    opened
      .filter((order) => OPEN_GIFT_STATUSES.has(order.status))
      .map((order) => ({
        id: order.id,
        createdAt: order.createdAt,
        influencerId: order.campaignCreator.influencerId,
        country: order.country,
        // Every product of the gift counts: all units, and the dearest product against the price cap.
        quantity: order.quantity + order.lines.reduce((sum, line) => sum + line.quantity, 0),
        productPriceUsd: (() => {
          const prices = [order.product.price, ...order.lines.map((line) => line.product.price)].filter((price) => price !== null).map(Number);
          return prices.length > 0 ? Math.max(...prices) : null;
        })(),
        collaborationType: order.campaignCreator.collaborationType,
        approvedFee: order.campaignCreator.approvedFee,
      })),
  );
  const orders: GiftRow[] = opened.map((order) => {
    const price = order.product.price === null ? null : Number(order.product.price);
    return {
      id: order.id,
      reference: giftReference(order.id),
      status: order.status,
      quantity: order.quantity,
      createdAt: order.createdAt,
      shippedAt: order.shippedAt,
      deliveredAt: order.deliveredAt,
      orderNumber: order.orderNumber,
      carrier: order.carrier,
      trackingNumber: order.trackingNumber,
      trackingStatus: order.trackingStatus,
      approvalNote: order.approvalNote,
      creatorNote: order.creatorNote,
      shipName: order.shipName,
      address1: order.address1,
      address2: order.address2,
      city: order.city,
      state: order.state,
      postalCode: order.postalCode,
      country: order.country,
      phone: order.phone,
      product: { ...order.product, price },
      extraItems: order.lines.map((line) => ({ label: describeProduct(line.product), sku: line.product.sku, quantity: line.quantity })),
      creator: order.campaignCreator.influencer,
      campaign: order.campaignCreator.campaign.name,
      campaignCreatorId: order.campaignCreator.id,
      arrivalCheckDays: order.campaignCreator.campaign.arrivalCheckDays,
      firstDeliveryInCampaign: !campaignsWithDelivery.has(order.campaignCreator.campaign.id),
      // One-click Amazon orders, when the brand's SP-API keys are set; otherwise the Amazon file.
      amazon: { enabled: mcfConfigured(order.campaignCreator.campaign.brandId), sentAt: order.mcfSentAt, status: order.mcfStatus, error: order.mcfError, trackingLink: order.trackingLink },
      // The company ERP: send the gift there as a Content Creators order (when ERP_ORDERS_URL and ERP_SECRET are set).
      erp: { enabled: erpConfigured(), sentAt: order.erpSentAt, url: order.erpUrl, error: order.erpError },
      checks: checks.get(order.id) ?? [],
    };
  });

  return (
    <>
      <PageHeader
        title="Gifts"
        meta={`${brandsLabel(view.brandId, "Both brands")} · ${openCount} open · ${countOf.get("needs_approval") ?? 0} to approve`}
      >
        <GiftCreatorButton campaigns={giftCampaigns.map((campaign) => ({ id: campaign.id, name: campaign.name, brand: brandShortName(campaign.brandId) }))} />
        <Button asChild variant="outline">
          <a href="#tracking">
            <ClipboardPaste strokeWidth={2.4} />
            Paste tracking
          </a>
        </Button>
        {toOrder.map(({ brand, count }) => (
          <Button asChild variant="action" key={brand.id}>
            <a href={`/orders/export?brand=${brand.id}`}>
              <Download strokeWidth={2.4} />
              Amazon file, {brand.short} ({count})
            </a>
          </Button>
        ))}
      </PageHeader>

      <nav id="gifts-tabs" aria-label="Filter by status" className="tabs mb-5">
        <Link href={sort === "newest" ? "/orders" : `/orders?sort=${sort}`} className="tab" aria-current={filter === null ? "true" : undefined}>
          All open <span className="count-pill">{openCount}</span>
        </Link>
        {GIFT_STATUSES.map((status) => (
          <Link key={status} href={`/orders?status=${status}${sort === "newest" ? "" : `&sort=${sort}`}`} className="tab" aria-current={filter === status ? "true" : undefined} title={GIFT_STATUS_LABELS[status]}>
            {TAB_LABELS[status]}
            {status !== "cancelled" ? <span className="count-pill">{countOf.get(status) ?? 0}</span> : null}
          </Link>
        ))}
      </nav>

      <GiftsTable
        orders={orders}
        sort={{ value: sort, options: SORTS, status: filter }}
        footer={orders.length === 0 ? "" : `1 to ${orders.length} of ${orders.length}${orders.length === PAGE_SIZE ? " shown" : ""} · Rows per page ${PAGE_SIZE}`}
      />

      <section id="tracking" className="card mt-8 p-5 md:p-6">
        <h2>Update tracking in bulk</h2>
        <TrackingImportForm />
        <details className="disclosure mt-5 border-t pt-4">
          <summary>How orders reach Amazon</summary>
          <ol className="mt-3 grid list-decimal gap-1.5 pl-5 text-sm font-medium text-muted-foreground">
            <li>Download the Amazon file at the top. Each brand has its own file, because each ships from its own Amazon account.</li>
            <li>Upload it in that brand&apos;s Seller Central: Multi-Channel Fulfillment, bulk order upload.</li>
            <li>Paste Amazon&apos;s order numbers and tracking here. The delivery date starts the creator&apos;s content clock.</li>
          </ol>
        </details>
      </section>
    </>
  );
}
