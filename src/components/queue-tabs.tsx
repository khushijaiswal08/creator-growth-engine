"use client";

import { cn } from "cn";
import { ChevronDown, Flame } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export type QueueTab = { key: string; label: string; count: number; href: string; active: boolean; hot?: boolean };

/**
 * The tabs across Home's task list: the busiest queues up front, the rest in a
 * "More" menu so the row never wraps into a wall of chips. The More tab takes
 * the name of the queue chosen from it.
 */
export function QueueTabs({ tabs, more }: { tabs: QueueTab[]; more: QueueTab[] }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const chosen = more.find((tab) => tab.active) ?? null;
  const moreCount = more.reduce((sum, tab) => sum + tab.count, 0);

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
    <nav aria-label="Task queues" className="tabs mt-3 px-2.5 max-md:flex-wrap max-md:overflow-visible md:px-[11px]">
      {tabs.map((tab) => (
        <Link key={tab.key} href={tab.href} className="tab" aria-current={tab.active ? "page" : undefined}>
          {tab.hot ? <Flame className="size-3.5 text-danger-text" strokeWidth={2.4} /> : null}
          {tab.label}
          <span className="count-pill">{tab.count.toLocaleString("en-US")}</span>
        </Link>
      ))}
      {more.length > 0 ? (
        <div ref={box} className="relative">
          <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="menu" className="tab" aria-current={chosen ? "page" : undefined}>
            {chosen ? chosen.label : "More"}
            <span className="count-pill">{(chosen ? chosen.count : moreCount).toLocaleString("en-US")}</span>
            <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} strokeWidth={2.4} />
          </button>
          {open ? (
            <div role="menu" className="card absolute top-full left-0 z-30 mt-1.5 grid w-60 gap-0.5 p-1.5 shadow-[var(--shadow-lift)]">
              {more.map((tab) => (
                <Link
                  key={tab.key}
                  href={tab.href}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  className={cn("flex h-10 items-center justify-between rounded-[10px] px-3 text-sm font-semibold hover:bg-surface-2", tab.active ? "bg-primary-faint text-primary" : "text-foreground")}
                >
                  {tab.label}
                  <span className="count-pill">{tab.count.toLocaleString("en-US")}</span>
                </Link>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </nav>
  );
}
