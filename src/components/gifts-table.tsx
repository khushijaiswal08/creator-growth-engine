"use client";

import type { GiftOrderStatus } from "@prisma/client";
import { cn } from "cn";
import { X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { decideGift, markDelivered } from "@/actions/gifts";
import { Avatar } from "@/components/avatar";
import { GiftTrackingForm } from "@/components/journey-forms";
import { ProductPhoto } from "@/components/product-photo";
import { Pill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { formatDay } from "@/lib/format";
import { GIFT_STATUS_LABELS, GIFT_STATUS_TONES } from "@/lib/gifts";
import { trackingUrl } from "@/lib/tracking";

export type GiftRow = {
  id: string;
  reference: string;
  status: GiftOrderStatus;
  quantity: number;
  createdAt: Date;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  orderNumber: string | null;
  carrier: string | null;
  trackingNumber: string | null;
  trackingStatus: string | null;
  approvalNote: string | null;
  creatorNote: string | null;
  shipName: string;
  address1: string;
  address2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string | null;
  product: { title: string; color: string | null; size: string | null; sku: string; amazonUrl: string | null; price: number | null; imageUrl: string | null; stock: number | null };
  creator: { id: string; name: string };
  campaign: string;
  /** The gifting rules, each passed or not. Empty for closed orders. */
  checks: { rule: string; passed: boolean; reason: string | null }[];
};

const RULE_LABELS: Record<string, string> = {
  allowedCountries: "US address",
  maxQuantity: "One item",
  maxProductPriceUsd: "Under the price cap",
  repeatGiftDays: "No gift to this creator in the last 90 days",
  paidCollaborationNeedsApprovedFee: "Not a paid collaboration without an approved fee",
};

function addressOf(order: GiftRow): string {
  return [order.shipName, order.address1, order.address2, order.city, [order.state, order.postalCode].filter(Boolean).join(" "), order.country].filter(Boolean).join(", ");
}

const OPEN: ReadonlySet<GiftOrderStatus> = new Set(["needs_approval", "approved", "ordered", "shipped", "exception"]);

/**
 * One row per gift order, checkboxes for bulk work, and a drawer on the right
 * with everything about the chosen order: product, address, the rules it
 * passed, tracking and the buttons. Addresses arrive already decrypted from
 * the page, which is signed in and brand scoped.
 */
export function GiftsTable({ orders }: { orders: GiftRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<string | null>(null);
  const open = orders.find((order) => order.id === openId) ?? null;

  const chosen = orders.filter((order) => selected.has(order.id));
  const approvable = chosen.filter((order) => order.status === "needs_approval");
  const cancellable = chosen.filter((order) => OPEN.has(order.status));

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function run(label: string, work: () => Promise<void>) {
    startTransition(async () => {
      await work();
      setSelected(new Set());
      setNotice(label);
      router.refresh();
    });
  }

  async function copyAddresses(rows: GiftRow[]) {
    const text = rows.map((order) => `${order.reference}\t${addressOf(order)}${order.phone ? `\t${order.phone}` : ""}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`${rows.length === 1 ? "Address" : `${rows.length} addresses`} copied.`);
    } catch {
      window.prompt("Copy these addresses:", text);
    }
  }

  return (
    <div className="flex items-start gap-5">
      <section className="card min-w-0 flex-1 overflow-hidden">
        <div className={cn("flex min-h-12 flex-wrap items-center gap-2 border-b px-4 py-2", selected.size > 0 ? "bg-primary-soft/40" : "bg-surface")}>
          {selected.size > 0 ? (
            <>
              <span className="mr-1 text-sm font-semibold">{selected.size} selected</span>
              {approvable.length > 0 ? (
                <Button size="sm" variant="action" disabled={pending} onClick={() => run(`${approvable.length} approved.`, async () => { for (const order of approvable) await decideGift(order.id, "approve"); })}>
                  Approve {approvable.length}
                </Button>
              ) : null}
              <Button size="sm" variant="outline" disabled={pending} onClick={() => copyAddresses(chosen)}>
                Copy addresses
              </Button>
              {cancellable.length > 0 ? (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={pending}
                  onClick={() => {
                    if (window.confirm(`Cancel ${cancellable.length === 1 ? "this order" : `${cancellable.length} orders`}? The creator will not receive the gift.`)) {
                      run(`${cancellable.length} cancelled.`, async () => { for (const order of cancellable) await decideGift(order.id, "cancel"); });
                    }
                  }}
                >
                  Cancel {cancellable.length}
                </Button>
              ) : null}
              <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">Tick orders to approve, copy or cancel several at once. Click a row for details.</span>
          )}
          {notice ? (
            <span role="status" className="ml-auto text-xs text-success-text">
              {notice}
            </span>
          ) : null}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-surface-2/60 text-xs font-semibold text-muted-foreground">
                <th className="w-9 px-3 py-2 text-left">
                  <input
                    type="checkbox"
                    aria-label="Select all orders"
                    checked={orders.length > 0 && selected.size === orders.length}
                    onChange={(event) => setSelected(event.target.checked ? new Set(orders.map((order) => order.id)) : new Set())}
                  />
                </th>
                <th className="px-3 py-2 text-left">Creator</th>
                <th className="px-3 py-2 text-left">Product</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Chosen</th>
                <th className="px-3 py-2 text-left">Carrier · tracking</th>
                <th className="px-3 py-2 text-left">Rules</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-muted-foreground">
                    No gift orders here. They appear when a creator uses their product selection link.
                  </td>
                </tr>
              ) : (
                orders.map((order) => {
                  const failed = order.checks.filter((check) => !check.passed);
                  return (
                    <tr
                      key={order.id}
                      onClick={() => setOpenId(order.id)}
                      className={cn("cursor-pointer border-t hover:bg-surface-2/50", openId === order.id && "bg-primary-soft/30", selected.has(order.id) && "bg-primary-soft/20")}
                    >
                      <td className="px-3 py-2.5" onClick={(event) => event.stopPropagation()}>
                        <input type="checkbox" aria-label={`Select the order for ${order.creator.name}`} checked={selected.has(order.id)} onChange={() => toggle(order.id)} />
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={order.creator.name} className="size-7 text-[11px]" />
                          <div className="min-w-0">
                            <Link href={`/influencers/${order.creator.id}`} className="font-semibold hover:text-primary-text" onClick={(event) => event.stopPropagation()}>
                              {order.creator.name}
                            </Link>
                            <div className="truncate text-xs text-muted-foreground">{order.campaign}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="font-semibold">
                          {[order.product.title, order.product.color].filter(Boolean).join(", ")}
                          {order.quantity > 1 ? ` × ${order.quantity}` : ""}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {order.product.sku}
                          {order.product.price !== null ? ` · $${order.product.price.toFixed(2)}` : ""}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <Pill tone={GIFT_STATUS_TONES[order.status]}>{GIFT_STATUS_LABELS[order.status]}</Pill>
                        {order.deliveredAt ? <div className="mt-0.5 text-xs text-muted-foreground">{formatDay(order.deliveredAt)}</div> : order.shippedAt ? <div className="mt-0.5 text-xs text-muted-foreground">{formatDay(order.shippedAt)}</div> : null}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap text-muted-foreground">{formatDay(order.createdAt)}</td>
                      <td className="px-3 py-2.5">
                        {order.trackingNumber ? (
                          <>
                            <a href={trackingUrl(order.carrier, order.trackingNumber)} target="_blank" rel="noopener noreferrer" className="link" onClick={(event) => event.stopPropagation()}>
                              {order.carrier ? `${order.carrier} · ` : ""}
                              {order.trackingNumber.length > 14 ? `${order.trackingNumber.slice(0, 8)}…${order.trackingNumber.slice(-4)}` : order.trackingNumber}
                            </a>
                            {order.trackingStatus ? <div className="text-xs text-muted-foreground">{order.trackingStatus}</div> : null}
                          </>
                        ) : order.status === "approved" ? (
                          <span className="text-xs text-muted-foreground">In the next Amazon file</span>
                        ) : order.status === "needs_approval" ? (
                          <span className="text-xs text-muted-foreground">Not ordered yet</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">{order.orderNumber ? `Amazon ${order.orderNumber}` : "–"}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        {order.checks.length === 0 ? (
                          <span className="text-xs text-muted-foreground">–</span>
                        ) : failed.length === 0 ? (
                          <Pill tone="success">{order.checks.length} of {order.checks.length} passed</Pill>
                        ) : (
                          <Pill tone="warning">{failed.length} to check</Pill>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {order.status === "needs_approval" ? (
                          <Button size="sm" variant="action" disabled={pending} onClick={(event) => { event.stopPropagation(); run("Approved.", () => decideGift(order.id, "approve")); }}>
                            Approve
                          </Button>
                        ) : order.status === "shipped" || order.status === "ordered" || order.status === "exception" ? (
                          <Button size="sm" variant="outline" disabled={pending} onClick={(event) => { event.stopPropagation(); run("Marked delivered.", () => markDelivered(order.id)); }}>
                            Delivered
                          </Button>
                        ) : (
                          <Button size="sm" variant="outline" onClick={(event) => { event.stopPropagation(); setOpenId(order.id); }}>
                            Open
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {open ? (
        <aside
          aria-label="Order details"
          className="card fixed inset-x-0 bottom-0 z-40 max-h-[90vh] overflow-y-auto rounded-b-none shadow-lg lg:sticky lg:top-[4.5rem] lg:inset-auto lg:z-auto lg:max-h-[calc(100vh-5.5rem)] lg:w-[380px] lg:shrink-0 lg:rounded-lg lg:shadow-none"
        >
          <div className="flex items-center gap-3 border-b px-4 py-3">
            <Avatar name={open.creator.name} />
            <div className="min-w-0 flex-1">
              <Link href={`/influencers/${open.creator.id}`} className="font-semibold hover:text-primary-text">
                {open.creator.name}
              </Link>
              <div className="truncate text-xs text-muted-foreground">
                {open.campaign} · {open.reference}
              </div>
            </div>
            <Pill tone={GIFT_STATUS_TONES[open.status]}>{GIFT_STATUS_LABELS[open.status]}</Pill>
            <button type="button" aria-label="Close details" onClick={() => setOpenId(null)} className="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground">
              <X className="size-4" />
            </button>
          </div>

          <div className="grid gap-5 p-4">
            <div className="flex items-start gap-3">
              <ProductPhoto url={open.product.imageUrl} size={56} className="size-14 shrink-0 rounded-md" />
              <div className="min-w-0 text-sm">
                <p className="font-semibold">
                  {[open.product.title, open.product.color, open.product.size].filter(Boolean).join(", ")}
                  {open.quantity > 1 ? ` × ${open.quantity}` : ""}
                </p>
                <p className="text-xs text-muted-foreground">
                  SKU {open.product.sku}
                  {open.product.price !== null ? ` · $${open.product.price.toFixed(2)}` : ""}
                  {open.product.stock !== null ? ` · ${open.product.stock} in stock` : ""}
                  {open.product.amazonUrl ? (
                    <>
                      {" · "}
                      <a className="link" href={open.product.amazonUrl} target="_blank" rel="noopener noreferrer">
                        Amazon
                      </a>
                    </>
                  ) : null}
                </p>
                {open.creatorNote ? <p className="mt-1 text-xs text-muted-foreground">Creator&apos;s note: {open.creatorNote}</p> : null}
                {open.orderNumber ? <p className="mt-1 text-xs text-muted-foreground">Amazon order {open.orderNumber}</p> : null}
              </div>
            </div>

            <div>
              <p className="label mb-1.5">Ship to</p>
              <p className="text-sm">
                {open.shipName}
                <br />
                {open.address1}
                {open.address2 ? (
                  <>
                    <br />
                    {open.address2}
                  </>
                ) : null}
                <br />
                {open.city}, {open.state} {open.postalCode}
                <br />
                {open.country}
                {open.phone ? (
                  <>
                    <br />
                    <span className="text-muted-foreground">Phone {open.phone}</span>
                  </>
                ) : null}
              </p>
              <Button size="sm" variant="outline" className="mt-2" onClick={() => copyAddresses([open])}>
                Copy address
              </Button>
            </div>

            {open.checks.length > 0 ? (
              <div>
                <p className="label mb-1.5">Rules check</p>
                <ul className="grid gap-1 text-sm">
                  {open.checks.map((check) => (
                    <li key={check.rule} className="flex gap-2">
                      <span aria-hidden className={cn("font-bold", check.passed ? "text-success-text" : "text-danger-text")}>
                        {check.passed ? "✓" : "✗"}
                      </span>
                      <span>
                        {RULE_LABELS[check.rule] ?? check.rule}
                        {!check.passed && check.reason ? <span className="block text-xs text-danger-text">{check.reason}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
                {open.approvalNote && open.status === "needs_approval" ? <p className="mt-2 text-xs text-warning-text">{open.approvalNote}</p> : null}
              </div>
            ) : null}

            {open.status !== "needs_approval" && open.status !== "cancelled" ? (
              <div>
                <p className="label mb-1.5">Tracking</p>
                {open.trackingStatus && open.status === "exception" ? <p className="mb-2 text-sm text-danger-text">{open.trackingStatus}</p> : null}
                <GiftTrackingForm gift={{ id: open.id, orderNumber: open.orderNumber, carrier: open.carrier, trackingNumber: open.trackingNumber, delivered: open.status === "delivered" }} />
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2 border-t pt-4">
              {open.status === "needs_approval" ? (
                <Button variant="action" disabled={pending} onClick={() => run("Approved.", () => decideGift(open.id, "approve"))}>
                  Approve order
                </Button>
              ) : null}
              {open.status === "shipped" || open.status === "ordered" || open.status === "exception" ? (
                <Button variant="outline" disabled={pending} onClick={() => run("Marked delivered.", () => markDelivered(open.id))}>
                  Mark delivered today
                </Button>
              ) : null}
              {open.trackingNumber ? (
                <Button asChild variant="outline">
                  <a href={trackingUrl(open.carrier, open.trackingNumber)} target="_blank" rel="noopener noreferrer">
                    Track parcel
                  </a>
                </Button>
              ) : null}
              {OPEN.has(open.status) ? (
                <Button
                  variant="destructive"
                  disabled={pending}
                  onClick={() => {
                    if (window.confirm("Cancel this order? The creator will not receive the gift.")) run("Cancelled.", () => decideGift(open.id, "cancel"));
                  }}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
            {open.status === "needs_approval" ? <p className="text-xs text-muted-foreground">Approving writes the rules into the activity log and adds this order to the next Amazon file.</p> : null}
          </div>
        </aside>
      ) : null}
    </div>
  );
}
