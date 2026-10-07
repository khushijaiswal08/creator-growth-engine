"use client";

import { cn } from "cn";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setBrandView } from "@/actions/brand-view";
import { useSidebar } from "@/components/sidebar-context";
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
  const ui = useSidebar();
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
      <span className={cn("eyebrow px-1", ui.label)}>Showing</span>
      <select
        aria-label="Brand shown"
        value={current ?? ""}
        onChange={choose}
        disabled={pending}
        className={cn(SELECT, "appearance-none px-0 text-center", ui.railOnly)}
      >
        <option value="">All</option>
        {BRANDS.map((brand) => (
          <option key={brand.id} value={brand.id}>
            {brand.short}
          </option>
        ))}
      </select>
      <select aria-label="Brand shown" value={current ?? ""} onChange={choose} disabled={pending} className={cn(SELECT, "px-2.5", ui.wideOnly)}>
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
  const ui = useSidebar();
  return (
    <div className="grid gap-1" title={`You are working on ${name}`}>
      <span className={cn("eyebrow px-1", ui.label)}>Brand</span>
      <span className={cn("flex h-8 items-center rounded-full bg-primary-soft px-1 text-xs font-medium text-primary-text", ui.align, ui.preference === "expanded" ? "px-2.5" : ui.preference === null ? "lg:px-2.5" : "")}>
        <span className={ui.railOnly}>{short}</span>
        <span className={cn("truncate", ui.wideOnly)}>{name}</span>
      </span>
    </div>
  );
}
