"use client";

import { cn } from "cn";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setBrandView } from "@/actions/brand-view";
import { BRANDS } from "@/lib/brands";

function useChooseBrand() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const choose = (brandId: string) => {
    startTransition(async () => {
      await setBrandView(brandId);
      router.refresh();
    });
  };
  return { choose, pending };
}

/**
 * Top-bar control for someone who may see both brands: one segment per
 * brand plus "Both". Narrows every list; it is a preference, not a permission.
 */
export function BrandSegments({ current }: { current: string | null }) {
  const { choose, pending } = useChooseBrand();
  const options = [{ id: "", label: "Both" }, ...BRANDS.map((brand) => ({ id: brand.id, label: brand.short }))];
  return (
    <div role="group" aria-label="Brand shown" className={cn("inline-flex rounded-md bg-surface-2 p-0.5", pending && "opacity-60")}>
      {options.map((option) => {
        const active = (current ?? "") === option.id;
        return (
          <button
            key={option.id}
            type="button"
            aria-pressed={active}
            disabled={pending}
            onClick={() => choose(option.id)}
            className={cn(
              "h-7 rounded-[5px] px-3 text-xs font-semibold whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active ? "bg-surface text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** The same choice as a plain select, for the phone drawer. */
export function BrandSwitcher({ current }: { current: string | null }) {
  const { choose, pending } = useChooseBrand();
  return (
    <label className="grid gap-1">
      <span className="eyebrow">Showing</span>
      <select
        aria-label="Brand shown"
        value={current ?? ""}
        onChange={(event) => choose(event.target.value)}
        disabled={pending}
        className="h-9 w-full rounded-md border border-input bg-surface px-2 text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      >
        <option value="">Both brands</option>
        {BRANDS.map((brand) => (
          <option key={brand.id} value={brand.id}>
            {brand.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** For someone who works on one brand: its name, so it is always clear whose data this is. */
export function BrandBadge({ name }: { name: string }) {
  return (
    <span title={`You are working on ${name}`} className="inline-flex h-7 items-center rounded-md bg-primary-soft px-2.5 text-xs font-semibold whitespace-nowrap text-primary-text">
      {name}
    </span>
  );
}
