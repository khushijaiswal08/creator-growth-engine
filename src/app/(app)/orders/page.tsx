import type { GiftOrderStatus } from "@prisma/client";
import type { Metadata } from "next";
import Link from "next/link";
import { GiftsTable, type GiftRow } from "@/components/gifts-table";
import { TrackingImportForm } from "@/components/journey-forms";
import { PageHeader } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { openAddress } from "@/lib/address-crypto";
import { viewed } from "@/lib/brand-scope";
import { BRANDS, brandName } from "@/lib/brands";
import { db } from "@/lib/db";
import { approvalChecks, GIFT_STATUS_LABELS, GIFT_STATUSES, giftReference } from "@/lib/gifts";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Gifts" };

const PAGE_SIZE = 50;
const CHECKED: ReadonlySet<GiftOrderStatus> = new Set(["needs_approval", "approved", "ordered", "shipped", "exception"]);

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const view = viewed(await requireUser());
  const raw = (await searchParams).status ?? "";
  const filter = GIFT_STATUSES.includes(raw as GiftOrderStatus) ? (raw as GiftOrderStatus) : null;

  const [stored, counts] = await Promise.all([
    db.giftOrder.findMany({
      where: { ...view.gifts, status: filter ?? { not: "cancelled" } },
      orderBy: { createdAt: "desc" },
      take: PAGE_SIZE,
      include: {
        product: { select: { title: true, color: true, size: true, sku: true, amazonUrl: true, price: true, imageUrl: true, stock: true } },
        campaignCreator: {
          select: { influencerId: true, collaborationType: true, approvedFee: true, campaign: { select: { name: true } }, influencer: { select: { id: true, name: true } } },
        },
      },
    }),
    db.giftOrder.groupBy({ by: ["status"], where: view.gifts, _count: { _all: true } }),
  ]);
  const countOf = new Map(counts.map((row) => [row.status, row._count._all]));
  const openCount = GIFT_STATUSES.filter((status) => status !== "cancelled" && status !== "delivered").reduce((sum, status) => sum + (countOf.get(status) ?? 0), 0);

  // Addresses are encrypted at rest; only this signed-in, brand-scoped page reads them.
  // Open orders also carry the rules they passed or failed, so the drawer can show them.
  const orders: GiftRow[] = await Promise.all(
    stored.map(openAddress).map(async (order) => ({
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
      product: { ...order.product, price: order.product.price === null ? null : Number(order.product.price) },
      creator: order.campaignCreator.influencer,
      campaign: order.campaignCreator.campaign.name,
      checks: CHECKED.has(order.status)
        ? await approvalChecks({
            influencerId: order.campaignCreator.influencerId,
            country: order.country,
            quantity: order.quantity,
            productPriceUsd: order.product.price === null ? null : Number(order.product.price),
            collaborationType: order.campaignCreator.collaborationType,
            approvedFee: order.campaignCreator.approvedFee,
          }, { id: order.id, createdAt: order.createdAt })
        : [],
    })),
  );

  // Each brand ships from its own Amazon account, so there is one order file per brand.
  const toOrder = (
    await Promise.all(
      BRANDS.filter((brand) => view.includes(brand.id)).map(async (brand) => ({
        brand,
        count: await db.giftOrder.count({ where: { status: "approved", campaignCreator: { campaign: { brandId: brand.id } } } }),
      })),
    )
  ).filter((row) => row.count > 0);

  return (
    <>
      <PageHeader
        title="Gifts"
        meta={`${view.brandId ? brandName(view.brandId) : "Both brands"} · ${openCount} open ${openCount === 1 ? "order" : "orders"} · ${countOf.get("needs_approval") ?? 0} waiting for approval`}
      >
        <Button asChild variant="outline">
          <a href="#tracking">Paste tracking</a>
        </Button>
        {toOrder.map(({ brand, count }) => (
          <Button asChild variant="action" key={brand.id}>
            <a href={`/orders/export?brand=${brand.id}`}>
              Amazon order file, {brand.short} ({count})
            </a>
          </Button>
        ))}
      </PageHeader>

      <nav aria-label="Filter by status" className="tabs mb-5">
        <Link href="/orders" className="tab" aria-current={filter === null ? "true" : undefined}>
          All open <span className="chip border-transparent bg-surface-2 px-1.5 py-0 text-[11px]">{openCount}</span>
        </Link>
        {GIFT_STATUSES.map((status) => (
          <Link key={status} href={`/orders?status=${status}`} className="tab" aria-current={filter === status ? "true" : undefined}>
            {GIFT_STATUS_LABELS[status]} <span className="chip border-transparent bg-surface-2 px-1.5 py-0 text-[11px]">{countOf.get(status) ?? 0}</span>
          </Link>
        ))}
      </nav>

      <GiftsTable orders={orders} />

      <div className="mt-10 grid gap-5 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="mb-2">How orders reach Amazon</h2>
          <ol className="grid list-decimal gap-1.5 pl-5 text-sm text-muted-foreground">
            <li>Click &quot;Amazon order file&quot; at the top. It lists every approved order of one brand, because each brand ships from its own Amazon account.</li>
            <li>Upload the file in that brand&apos;s Seller Central under Multi-Channel Fulfillment, bulk order upload.</li>
            <li>When Amazon gives order numbers and tracking, paste them here. Delivery dates start each creator&apos;s content clock.</li>
          </ol>
        </section>
        <section id="tracking" className="card p-5">
          <h2>Update tracking in bulk</h2>
          <TrackingImportForm />
        </section>
      </div>
    </>
  );
}
