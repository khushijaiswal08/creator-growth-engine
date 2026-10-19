"use client";

import { cn } from "cn";
import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** The class for each entry in the menu: links, buttons and forms' submit buttons alike. */
export const MENU_ITEM_CLASS = "flex h-10 w-full items-center gap-2.5 rounded-md px-3 text-left text-sm text-foreground outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring md:h-9";

/** The "⋯" button and the menu under it. Put links, buttons or small forms inside, each with MENU_ITEM_CLASS. */
export function ActionMenu({ label = "More actions", align = "right", children }: { label?: string; align?: "left" | "right"; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: MouseEvent) {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex size-9 items-center justify-center rounded-md border border-border-strong bg-surface text-foreground outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring max-md:size-11"
      >
        <MoreHorizontal className="size-[18px]" strokeWidth={2} />
      </button>
      {open ? (
        <div role="menu" onClick={() => setOpen(false)} className={cn("card absolute top-full z-40 mt-2 w-60 p-1.5 shadow-lg", align === "right" ? "right-0" : "left-0")}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
