"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setBrandView } from "@/actions/brand-view";
import { BRANDS } from "@/lib/brands";

const SELECT =
  "h-8 w-full cursor-pointer rounded-full border border-border-strong bg-transparent text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

/**
 * Sidebar control for someone who may see both brands: narrows every list to
 * one brand, or back to both. Two selects, one per sidebar width, because the
 * narrow rail only has room for a few letters.
 */
export function BrandSwitcher({ current }: { current: string | null }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const choose = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const brandId = event.target.value;
    startTransition(async () => {
      await setBrandView(brandId);
      router.refresh();
    });
  };

  return (
    <div className="grid gap-1">
      <span className="eyebrow sr-only px-1 lg:not-sr-only">Showing</span>
      <select
        aria-label="Brand shown"
        value={current ?? ""}
        onChange={choose}
        disabled={pending}
        className={`${SELECT} appearance-none px-0 text-center lg:hidden`}
      >
        <option value="">All</option>
        {BRANDS.map((brand) => (
          <option key={brand.id} value={brand.id}>
            {brand.short}
          </option>
        ))}
      </select>
      <select aria-label="Brand shown" value={current ?? ""} onChange={choose} disabled={pending} className={`${SELECT} hidden px-2.5 lg:block`}>
        <option value="">Both brands</option>
        {BRANDS.map((brand) => (
          <option key={brand.id} value={brand.id}>
            {brand.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** For someone who works on one brand: its name, so it is always clear whose data this is. */
export function BrandBadge({ name, short }: { name: string; short: string }) {
  return (
    <div className="grid gap-1" title={`You are working on ${name}`}>
      <span className="eyebrow sr-only px-1 lg:not-sr-only">Brand</span>
      <span className="flex h-8 items-center justify-center rounded-full bg-primary-soft px-1 text-xs font-medium text-primary-text lg:justify-start lg:px-2.5">
        <span className="lg:hidden">{short}</span>
        <span className="hidden truncate lg:inline">{name}</span>
      </span>
    </div>
  );
}
