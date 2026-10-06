import type { Metadata } from "next";
import Link from "next/link";
import { setOffered } from "@/actions/journey";
import { OfferListForm, ProductUploadForm } from "@/components/journey-forms";
import { NativeSelect } from "@/components/native-select";
import { EmptyRow, PageHeader, Panel } from "@/components/panel";
import { ProductPhoto } from "@/components/product-photo";
import { Pill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BRANDS, brandName, isBrandId } from "@/lib/brands";
import { db } from "@/lib/db";
import {
  isFiltered,
  isOfferStatus,
  OFFER_STATUS_LABELS,
  OFFER_STATUS_TONES,
  OFFER_STATUS_WHERE,
  OFFER_STATUSES,
  offerStatus,
  productListWhere,
} from "@/lib/product-list";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Products" };

const PAGE_SIZE = 100;
const number = (n: number) => n.toLocaleString("en-US");

export default async function ProductsPage({ searchParams }: { searchParams: Promise<{ q?: string; brand?: string; view?: string }> }) {
  await requireAdmin();
  const params = await searchParams;
  const filter = {
    q: (params.q ?? "").trim().slice(0, 100),
    brand: isBrandId(params.brand ?? "") ? (params.brand ?? "") : "",
    view: isOfferStatus(params.view ?? "") ? (params.view ?? "") : "",
  };
  const where = productListWhere(filter);
  // The status pills count within the search and brand, whichever status is open.
  const withinSearch = productListWhere({ ...filter, view: "" });

  const [products, total, statusCounts, liveByBrand, offeredByBrand, stockKnown] = await Promise.all([
    db.product.findMany({
      where,
      orderBy: [{ archived: "asc" }, { stock: { sort: "desc", nulls: "last" } }, { title: "asc" }, { color: "asc" }, { sku: "asc" }],
      take: PAGE_SIZE,
    }),
    db.product.count({ where }),
    Promise.all(OFFER_STATUSES.map((status) => db.product.count({ where: { AND: [withinSearch, OFFER_STATUS_WHERE[status]] } }))),
    db.product.groupBy({ by: ["brandId"], where: { archived: false }, _count: { _all: true } }),
    db.product.groupBy({ by: ["brandId"], where: OFFER_STATUS_WHERE.offered, _count: { _all: true } }),
    db.product.count({ where: { archived: false, stock: { not: null } } }),
  ]);
  const countOf = (rows: { brandId: string; _count: { _all: number } }[], brandId: string) =>
    rows.find((row) => row.brandId === brandId)?._count._all ?? 0;
  const allInSearch = statusCounts.reduce((sum, n) => sum + n, 0);

  const href = (view: string) => {
    const query = new URLSearchParams();
    if (filter.q) query.set("q", filter.q);
    if (filter.brand) query.set("brand", filter.brand);
    if (view) query.set("view", view);
    const text = query.toString();
    return text ? `/admin/products?${text}` : "/admin/products";
  };

  return (
    <>
      <PageHeader
        title="Products"
        meta={
          liveByBrand.length === 0 ? (
            "No products yet."
          ) : (
            <>
              {BRANDS.map((brand) => (
                <span key={brand.id} className="block">
                  {brand.name}: {number(countOf(liveByBrand, brand.id))} live on Amazon, {number(countOf(offeredByBrand, brand.id))} offered to
                  creators.
                </span>
              ))}
              <span className="block">{stockKnown === 0 ? "Stock is not known yet: upload an Amazon inventory file." : `Stock known for ${number(stockKnown)}.`}</span>
            </>
          )
        }
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel>
          <form method="get" className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
            <label htmlFor="q" className="sr-only">
              Search products
            </label>
            <Input id="q" name="q" type="search" defaultValue={filter.q} placeholder="Search name, colour, SKU or ASIN" className="h-8 max-w-xs" />
            <label htmlFor="brand" className="sr-only">
              Brand
            </label>
            <NativeSelect id="brand" name="brand" defaultValue={filter.brand} className="h-8 w-auto">
              <option value="">Both brands</option>
              {BRANDS.map((brand) => (
                <option key={brand.id} value={brand.id}>
                  {brand.name}
                </option>
              ))}
            </NativeSelect>
            {filter.view ? <input type="hidden" name="view" value={filter.view} /> : null}
            <Button type="submit" size="sm">
              Search
            </Button>
            <span className="ml-auto text-muted-foreground tabular-nums">
              {total > products.length ? `First ${products.length} of ${number(total)}` : `${number(total)} products`}
            </span>
          </form>

          <nav aria-label="Filter by status" className="flex flex-wrap gap-1.5 border-b px-4 py-2.5">
            <Link href={href("")} className="chip" aria-current={filter.view === "" ? "true" : undefined}>
              All <span className="tabular-nums">{number(allInSearch)}</span>
            </Link>
            {OFFER_STATUSES.map((status, index) => (
              <Link
                key={status}
                href={href(status)}
                className="chip" aria-current={filter.view === status ? "true" : undefined}
              >
                {OFFER_STATUS_LABELS[status]} <span className="tabular-nums">{number(statusCounts[index])}</span>
              </Link>
            ))}
          </nav>

          {isFiltered(filter) ? <OfferListForm filter={filter} total={total} /> : null}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>Creators</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Price</TableHead>
                <TableHead className="text-right">Stock</TableHead>
                <TableHead>
                  <span className="sr-only">Links and actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.length === 0 ? (
                <EmptyRow colSpan={6}>{isFiltered(filter) ? "No products match." : "Upload a product list to get started."}</EmptyRow>
              ) : (
                products.map((product) => {
                  const status = offerStatus(product);
                  return (
                    <TableRow key={product.id}>
                      <TableCell className="whitespace-normal">
                        <div className="flex w-64 items-center gap-3 xl:w-80">
                          <ProductPhoto url={product.imageUrl} size={44} className="size-11 shrink-0 rounded-md border" />
                          <div className="min-w-0">
                            <p className="font-medium">{[product.title, product.color, product.size].filter(Boolean).join(" · ")}</p>
                            {product.listingName ? (
                              <p className="truncate text-xs text-muted-foreground" title={product.listingName}>
                                {product.listingName}
                              </p>
                            ) : null}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Pill tone={OFFER_STATUS_TONES[status]}>{OFFER_STATUS_LABELS[status]}</Pill>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {product.sku}
                        {filter.brand ? null : <span className="block text-xs text-muted-foreground">{brandName(product.brandId)}</span>}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{product.price ? `$${product.price.toFixed(2)}` : ""}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {product.stock ?? <span className="text-muted-foreground">not known</span>}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-2 whitespace-nowrap">
                          {product.amazonUrl ? (
                            <a className="link" href={product.amazonUrl} target="_blank" rel="noopener noreferrer">
                              Amazon
                            </a>
                          ) : null}
                          {product.websiteUrl ? (
                            <a className="link" href={product.websiteUrl} target="_blank" rel="noopener noreferrer">
                              Website
                            </a>
                          ) : null}
                          {product.archived ? null : (
                            <form action={setOffered}>
                              <input type="hidden" name="productId" value={product.id} />
                              <input type="hidden" name="offered" value={product.giftable ? "no" : "yes"} />
                              <Button type="submit" size="xs">
                                {product.giftable ? "Stop offering" : "Offer"}
                              </Button>
                            </form>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </Panel>

        <Panel title="Upload products or stock" className="self-start">
          <ProductUploadForm />
          <div className="grid gap-2 border-t p-4 text-muted-foreground">
            <p>Three kinds of file work here. Products are always matched on SKU.</p>
            <ul className="grid list-disc gap-1.5 pl-5">
              <li>
                <strong>Amazon&apos;s Category Listing Report</strong> (the .xlsx file, unchanged). Adds new listings, refreshes names, photos,
                links and prices, and hides anything that is no longer live on Amazon. Nothing is deleted.
              </li>
              <li>
                <strong>An Amazon inventory file</strong> (.csv or .txt). Refreshes stock: its SKU and quantity columns are recognised.
              </li>
              <li>
                <strong>Your own CSV</strong> with the columns sku (required), asin, title, listing_name, color, size, price, stock, website_url,
                image_url, giftable.
              </li>
            </ul>
            <p>
              Creators are shown the best-stocked products first. They are never shown a product that is sold out, switched off here, not live on
              Amazon, or without a link or photo to look at.
            </p>
          </div>
        </Panel>
      </div>
    </>
  );
}
