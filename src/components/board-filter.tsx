"use client";

import { cn } from "cn";
import { Filter } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NativeSelect } from "@/components/native-select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export type BoardFilters = { owner: string; platform: string; followers: string };

/** The "Filter" button on a campaign: owner, platform and a followers floor, applied by submitting the page's form. */
export function BoardFilter({ owners, values, view, q, mine }: { owners: { id: string; name: string }[]; values: BoardFilters; view: string; q: string; mine: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const active = [values.owner, values.platform, values.followers].filter(Boolean).length;

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={box} className="relative">
      <Button type="button" variant="outline" aria-expanded={open} onClick={() => setOpen((value) => !value)} className={cn(active > 0 && "border-primary text-primary-text")}>
        <Filter className="size-4" strokeWidth={2} />
        Filter{active > 0 ? ` (${active})` : ""}
      </Button>
      {open ? (
        <form method="get" className="card absolute top-full left-0 z-40 mt-2 grid w-72 gap-3 p-4 shadow-lg">
          {view !== "board" ? <input type="hidden" name="view" value={view} /> : null}
          {q ? <input type="hidden" name="q" value={q} /> : null}
          {mine ? <input type="hidden" name="mine" value="1" /> : null}
          <div className="grid gap-1.5">
            <Label htmlFor="filter-owner">Owner</Label>
            <NativeSelect id="filter-owner" name="owner" defaultValue={values.owner}>
              <option value="">Everyone</option>
              {owners.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="filter-platform">Platform</Label>
            <NativeSelect id="filter-platform" name="platform" defaultValue={values.platform}>
              <option value="">All</option>
              <option value="instagram">Instagram</option>
              <option value="youtube">YouTube</option>
              <option value="tiktok">TikTok</option>
            </NativeSelect>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="filter-followers">Followers</Label>
            <NativeSelect id="filter-followers" name="followers" defaultValue={values.followers}>
              <option value="">Any</option>
              <option value="10000">10K and up</option>
              <option value="50000">50K and up</option>
              <option value="100000">100K and up</option>
            </NativeSelect>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="action" size="sm">
              Apply
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
