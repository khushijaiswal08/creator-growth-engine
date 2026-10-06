import type { Metadata } from "next";
import { headers } from "next/headers";
import { brandName } from "@/lib/brands";
import { db } from "@/lib/db";
import { giftableProductsWhere } from "@/lib/gifts";
import { TERMINAL_STATUSES } from "@/lib/next-action";
import { callerIp, hitRateLimit, isRateLimited, RATE_LIMITS, recordHit } from "@/lib/rate-limit";
import { selectionLinkExpired } from "@/lib/selection";
import { firstName } from "@/lib/template";
import { SelectionForm, type SelectableProduct } from "./selection-form";

export const metadata: Metadata = { title: "Choose your product", robots: { index: false, follow: false } };

function Shell({ brand, children }: { brand: string; children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <p className="eyebrow mb-2">{brand}</p>
      <div className="card p-7">{children}</div>
    </main>
  );
}

/**
 * PUBLIC page: the creator's own product-selection link. The token in the
 * address is the only key, so the page shows nothing about the creator beyond
 * their first name, and nothing at all for an unknown, expired or used token.
 * Visits are rate limited per caller, and misses more tightly, so tokens
 * cannot be guessed by trying.
 */
export default async function SelectPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const ip = callerIp(await headers());

  if ((await isRateLimited(RATE_LIMITS.selectionMiss, ip)) || (await hitRateLimit(RATE_LIMITS.selectionView, ip))) {
    return (
      <Shell brand="Product selection">
        <h1 className="text-2xl">Please try again later</h1>
        <p className="mt-2 text-muted-foreground">Too many requests from this connection. The link will work again in a little while.</p>
      </Shell>
    );
  }

  const creator =
    token.length >= 20 && token.length <= 64
      ? await db.campaignCreator.findUnique({
          where: { selectionToken: token },
          select: {
            status: true,
            selectionExpiresAt: true,
            selectionUsedAt: true,
            campaign: { select: { brandId: true, giftArticles: true, status: true } },
            influencer: { select: { name: true, archived: true } },
            giftOrders: { where: { status: { not: "cancelled" } }, take: 1, select: { id: true } },
          },
        })
      : null;

  if (
    !creator ||
    creator.influencer.archived ||
    creator.campaign.status === "archived" ||
    TERMINAL_STATUSES.has(creator.status) ||
    selectionLinkExpired(creator)
  ) {
    await recordHit(RATE_LIMITS.selectionMiss, ip);
    return (
      <Shell brand="Product selection">
        <h1 className="text-2xl">This link is no longer active</h1>
        <p className="mt-2 text-muted-foreground">
          Links work for 14 days and once. Please reply to our message and we will send you a new one.
        </p>
      </Shell>
    );
  }

  const brand = brandName(creator.campaign.brandId);
  if (creator.giftOrders.length > 0) {
    return (
      <Shell brand={brand}>
        <h1 className="text-2xl">Thank you, your choice is in</h1>
        <p className="mt-2">We will send your tracking details as soon as it ships.</p>
        <p className="mt-2 text-muted-foreground">Need to change something? Reply to our message.</p>
      </Shell>
    );
  }

  const offered = await db.product.findMany({
    where: giftableProductsWhere(creator.campaign),
    // Best-stocked first, so what we have most of is what creators see first.
    orderBy: [{ stock: { sort: "desc", nulls: "last" } }, { title: "asc" }, { color: "asc" }, { size: "asc" }],
    select: { id: true, title: true, listingName: true, color: true, size: true, amazonUrl: true, websiteUrl: true, imageUrl: true, stock: true },
  });

  // Product types with the most stock come first; while stock is not known, the ones with the widest choice.
  const totals = new Map<string, { stock: number; choices: number }>();
  for (const product of offered) {
    const total = totals.get(product.title) ?? { stock: 0, choices: 0 };
    totals.set(product.title, { stock: total.stock + (product.stock ?? 0), choices: total.choices + 1 });
  }
  const categories = [...totals]
    .sort((a, b) => b[1].stock - a[1].stock || b[1].choices - a[1].choices || a[0].localeCompare(b[0]))
    .map(([title]) => title);
  // Stock numbers stay on the server: this page is public.
  const products: SelectableProduct[] = offered.map(({ id, title, listingName, color, size, amazonUrl, websiteUrl, imageUrl }) => ({
    id, title, listingName, color, size, amazonUrl, websiteUrl, imageUrl,
  }));

  return (
    <Shell brand={brand}>
      <h1 className="text-[28px] leading-tight">Hi {firstName(creator.influencer.name)}, choose your gift</h1>
      <p className="mt-2 mb-6 text-muted-foreground">
        Pick the piece you would like from {brand} and tell us where to send it. It takes about a minute.
      </p>
      {products.length === 0 ? (
        <p>We are updating our list right now. Please reply to our message and we will help you choose.</p>
      ) : (
        <SelectionForm token={token} categories={categories} products={products} />
      )}
    </Shell>
  );
}
