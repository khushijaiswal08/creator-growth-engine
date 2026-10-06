import type { GiftOrderStatus } from "@prisma/client";
import type { Metadata } from "next";
import Link from "next/link";
import { decideGift, markDelivered } from "@/actions/gifts";
import { GiftTrackingForm, TrackingImportForm } from "@/components/journey-forms";
import { openAddress } from "@/lib/address-crypto";
import { PageHeader, Panel } from "@/components/panel";
import { ProductPhoto } from "@/components/product-photo";
import { Pill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { viewed } from "@/lib/brand-scope";
import { BRANDS } from "@/lib/brands";
import { db } from "@/lib/db";
import { formatDay } from "@/lib/format";
import { GIFT_STATUS_LABELS, GIFT_STATUS_TONES, GIFT_STATUSES, giftReference } from "@/lib/gifts";
import { requireUser } from "@/lib/session";
import { TONE_DOT } from "@/lib/status";
import { trackingUrl } from "@/lib/tracking";

export const metadata: Metadata = { title: "Gift orders" };

const PAGE_SIZE = 50;

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
        product: { select: { title: true, listingName: true, color: true, size: true, sku: true, amazonUrl: true, price: true, imageUrl: true } },
        campaignCreator: {
          select: { campaign: { select: { name: true } }, influencer: { select: { id: true, name: true } } },
        },
      },
    }),
    db.giftOrder.groupBy({ by: ["status"], where: view.gifts, _count: { _all: true } }),
  ]);
  // Addresses are encrypted at rest; only this signed-in, brand-scoped page reads them.
  const orders = stored.map(openAddress);
  const countOf = new Map(counts.map((row) => [row.status, row._count._all]));
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
      <PageHeader title="Gift orders" meta="Creators choose their product and address themselves. Orders inside the rules are approved on their own.">
        {toOrder.map(({ brand, count }) => (
          <Button asChild variant="action" key={brand.id}>
            <a href={`/orders/export?brand=${brand.id}`}>
              Amazon order file, {brand.short} ({count})
            </a>
          </Button>
        ))}
      </PageHeader>

      <nav aria-label="Filter by status" className="flex flex-wrap gap-1.5">
        <Link href="/orders" className="chip" aria-current={filter === null ? "true" : undefined}>
          All open
        </Link>
        {GIFT_STATUSES.map((status) => (
          <Link key={status} href={`/orders?status=${status}`} className="chip" aria-current={filter === status ? "true" : undefined}>
            <span aria-hidden className={`size-1.5 rounded-full ${TONE_DOT[GIFT_STATUS_TONES[status]]}`} />
            {GIFT_STATUS_LABELS[status]} <span className="tabular-nums">{countOf.get(status) ?? 0}</span>
          </Link>
        ))}
      </nav>

      {orders.length === 0 ? (
        <p className="mt-10 py-10 text-center text-muted-foreground">No gift orders here. They appear when a creator uses their product selection link.</p>
      ) : (
        <ol className="mt-6 border-t">
          {orders.map((order) => {
            const open = order.status !== "delivered" && order.status !== "cancelled";
            return (
              <li key={order.id} className="grid gap-x-4 gap-y-3 border-b py-4 sm:grid-cols-[3.5rem_minmax(0,1fr)_auto]">
                <ProductPhoto url={order.product.imageUrl} size={56} className="size-14 rounded-md" />
                <div className="min-w-0">
                  <p>
                    <Link href={`/influencers/${order.campaignCreator.influencer.id}`} className="font-medium text-foreground hover:text-primary-text">
                      {order.campaignCreator.influencer.name}
                    </Link>
                    <span className="text-muted-foreground"> · {order.campaignCreator.campaign.name}</span>
                  </p>
                  <p>
                    {[order.product.title, order.product.color, order.product.size].filter(Boolean).join(", ")}
                    {order.quantity > 1 ? ` × ${order.quantity}` : ""}
                    {order.product.amazonUrl ? (
                      <>
                        {" "}
                        <a className="link text-xs" href={order.product.amazonUrl} target="_blank" rel="noopener noreferrer">
                          Amazon
                        </a>
                      </>
                    ) : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    SKU {order.product.sku}
                    {order.product.price ? ` · $${order.product.price.toFixed(2)}` : ""}
                    {" · "}
                    {giftReference(order.id)}
                    {order.orderNumber ? ` · Amazon ${order.orderNumber}` : ""}
                    {order.deliveredAt
                      ? ` · Delivered ${formatDay(order.deliveredAt)}`
                      : order.shippedAt
                        ? ` · Shipped ${formatDay(order.shippedAt)}`
                        : ` · Chosen ${formatDay(order.createdAt)}`}
                  </p>
                  {order.approvalNote && order.status === "needs_approval" ? (
                    <p className="mt-1 text-sm text-warning-text">Needs your approval: {order.approvalNote}</p>
                  ) : null}
                  {order.trackingStatus && order.status === "exception" ? <p className="mt-1 text-sm text-danger-text">{order.trackingStatus}</p> : null}

                  <details className="disclosure mt-2">
                    <summary>Address and tracking</summary>
                    <div className="grid gap-3 pt-3 text-sm">
                      <p>
                        <span className="text-muted-foreground">Ship to: </span>
                        {[order.shipName, order.address1, order.address2, order.city, [order.state, order.postalCode].filter(Boolean).join(" "), order.country]
                          .filter(Boolean)
                          .join(", ")}
                        {order.phone ? <span className="text-muted-foreground">. Phone {order.phone}</span> : null}
                      </p>
                      {order.creatorNote ? <p className="text-muted-foreground">Creator&apos;s note: {order.creatorNote}</p> : null}
                      {order.status !== "needs_approval" && order.status !== "cancelled" ? (
                        <GiftTrackingForm
                          gift={{
                            id: order.id,
                            orderNumber: order.orderNumber,
                            carrier: order.carrier,
                            trackingNumber: order.trackingNumber,
                            delivered: order.status === "delivered",
                          }}
                        />
                      ) : null}
                    </div>
                  </details>
                </div>

                <div className="flex flex-wrap items-center gap-2 sm:flex-col sm:items-end">
                  <Pill tone={GIFT_STATUS_TONES[order.status]}>{GIFT_STATUS_LABELS[order.status]}</Pill>
                  {order.status === "needs_approval" ? (
                    <form action={decideGift.bind(null, order.id, "approve")}>
                      <Button type="submit" size="xs" variant="action">
                        Approve
                      </Button>
                    </form>
                  ) : null}
                  {order.trackingNumber ? (
                    <Button asChild size="xs" variant="outline">
                      <a href={trackingUrl(order.carrier, order.trackingNumber)} target="_blank" rel="noopener noreferrer">
                        Track parcel
                      </a>
                    </Button>
                  ) : null}
                  {order.status === "shipped" || order.status === "ordered" || order.status === "exception" ? (
                    <form action={markDelivered.bind(null, order.id)}>
                      <Button type="submit" size="xs" variant="outline">
                        Mark delivered today
                      </Button>
                    </form>
                  ) : null}
                  {open ? (
                    <form action={decideGift.bind(null, order.id, "cancel")}>
                      <Button type="submit" size="xs" variant="ghost">
                        Cancel
                      </Button>
                    </form>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <div className="mt-14 grid gap-x-12 gap-y-10 lg:grid-cols-2">
        <Panel plain title="How orders reach Amazon">
          <ol className="grid list-decimal gap-1.5 pt-3 pl-5 text-muted-foreground">
            <li>Click &quot;Amazon order file&quot; at the top. It lists every approved order of one brand, because each brand ships from its own Amazon account.</li>
            <li>Upload the file in that brand&apos;s Seller Central under Multi-Channel Fulfillment, bulk order upload.</li>
            <li>When Amazon gives order numbers and tracking, paste them here. Delivery dates start each creator&apos;s content clock.</li>
          </ol>
        </Panel>
        <Panel plain title="Update tracking in bulk">
          <TrackingImportForm />
        </Panel>
      </div>
    </>
  );
}
