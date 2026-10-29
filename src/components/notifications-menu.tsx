"use client";

import { cn } from "cn";
import { Bell, CheckCircle2, ChevronRight, Clapperboard, Clock, Flame, Gift, ImageIcon, Link2, type LucideIcon, Reply, Send, Truck, UserCheck } from "lucide-react";
import Link from "next/link";
import { Popover } from "radix-ui";
import { useState } from "react";

/** One of Home's queues, as the bell lists it. */
export type NoticeQueue = { key: string; title: string; count: number };

const ICONS: Record<string, LucideIcon> = {
  replies: Reply,
  selection: Link2,
  followups: Clock,
  first: Send,
  gifts: Gift,
  delivery: Truck,
  content: Clapperboard,
  posted: ImageIcon,
  review: UserCheck,
};

const ROW = "flex items-center gap-3 rounded-xl px-3 py-2 outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/35";

/**
 * The bell: what needs this person right now, queue by queue, each a click
 * from its list. The badge is the sum of Home's queues, so the bell and Home
 * always show the same number. Hot creators and gift approvals are already
 * inside those queues, so they show as pointers, never added on top.
 */
export function NotificationsMenu({
  queues,
  approvals,
  hot,
  lateMax,
  buttonClassName,
}: {
  queues: NoticeQueue[];
  /** Gift orders the rules could not approve on their own; their creators are in the gifts queue. */
  approvals: number;
  /** Due creators whose reply was hot, across all queues. */
  hot: number;
  /** Days the oldest due step is late. */
  lateMax: number;
  buttonClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const rows = queues.filter((queue) => queue.count > 0);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const close = () => setOpen(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={total === 0 ? "Notifications: nothing needs you" : `Notifications: ${total} need you`}
          title={total === 0 ? "Nothing needs you right now" : `${total} ${total === 1 ? "thing needs" : "things need"} you`}
          className={cn(buttonClassName, open && "border-primary/40 bg-primary-faint text-primary-text")}
        >
          <Bell className="size-[18px]" strokeWidth={1.9} />
          {total > 0 ? (
            <span aria-hidden className="absolute -top-1.5 -right-2 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-surface bg-[#e11d48] px-1 text-[10.5px] leading-none font-extrabold text-white">
              {total > 99 ? "99+" : total}
            </span>
          ) : null}
        </button>
      </Popover.Trigger>

      {/* In a portal on top of everything (bottom bar, drawers, Rachna), kept inside the window. */}
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Notifications"
          className="card z-50 flex max-h-[min(640px,var(--radix-popover-content-available-height))] w-[min(360px,calc(100vw-24px))] flex-col overflow-hidden shadow-[0_24px_60px_rgba(15,23,42,0.18)] outline-none"
        >
          <div className="flex shrink-0 items-start justify-between gap-3 border-b px-5 py-4">
            <div className="min-w-0">
              <p className="text-[15px] font-extrabold text-foreground">Notifications</p>
              <p className={cn("mt-0.5 text-[13px] font-semibold", lateMax > 0 ? "text-danger-text" : "text-muted-foreground")}>
                {total === 0 ? "Nothing waiting" : lateMax > 0 ? `Oldest is ${lateMax} ${lateMax === 1 ? "day" : "days"} late` : "All on time"}
              </p>
            </div>
            {total > 0 ? <span className="count-pill">{total.toLocaleString("en-US")}</span> : null}
          </div>

          {rows.length === 0 ? (
            <div className="grid justify-items-center gap-2 px-5 py-9 text-center">
              <span className="flex size-11 items-center justify-center rounded-full bg-success-soft text-success-text">
                <CheckCircle2 className="size-6" strokeWidth={2} />
              </span>
              <p className="font-extrabold text-foreground">All caught up</p>
              <p className="max-w-[16rem] text-[13px] font-medium text-muted-foreground">New replies, parcels and approvals show up here.</p>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {hot > 0 ? (
                <Link href="/today?hot=1" onClick={close} className={cn(ROW, "mb-1 bg-danger-soft hover:bg-danger-soft/70")}>
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-surface text-danger-text">
                    <Flame className="size-4" strokeWidth={2.2} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-bold text-foreground">Hot creators</span>
                    <span className="block text-xs font-semibold text-danger-text">Do these first</span>
                  </span>
                  <span className="text-[15px] font-extrabold text-danger-text tabular-nums">{hot.toLocaleString("en-US")}</span>
                  <ChevronRight className="size-4 shrink-0 text-danger-text" strokeWidth={2.2} />
                </Link>
              ) : null}
              <ul>
                {rows.map((row) => {
                  const Icon = ICONS[row.key] ?? Bell;
                  const hint = row.key === "gifts" && approvals > 0 ? `${approvals} to approve` : null;
                  return (
                    <li key={row.key}>
                      <Link href={`/today?queue=${row.key}`} onClick={close} className={cn(ROW, "hover:bg-surface-2")}>
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-primary-faint text-primary-text">
                          <Icon className="size-4" strokeWidth={2} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-bold text-foreground">{row.title}</span>
                          {hint ? <span className="block text-xs font-semibold text-warning-text">{hint}</span> : null}
                        </span>
                        <span className="text-[15px] font-extrabold text-foreground tabular-nums">{row.count.toLocaleString("en-US")}</span>
                        <ChevronRight className="size-4 shrink-0 text-faint" strokeWidth={2.2} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <Link href="/today" onClick={close} className="block shrink-0 border-t px-5 py-3 text-center text-[13px] font-bold text-primary-text outline-none hover:bg-primary-faint focus-visible:bg-primary-faint">
            Open Home
          </Link>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
