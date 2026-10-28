"use client";

import type { CreatorStatus, Platform, TemplatePurpose } from "@prisma/client";
import { cn } from "cn";
import { Check, Clock, Eye, Flame, Link2, MessageCircle, Reply } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Avatar } from "@/components/avatar";
import { CreatorName } from "@/components/creator-card";
import { MessageButton } from "@/components/message-button";
import { CreatorStatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { formatCount, formatDay } from "@/lib/format";
import { WARMTH_LABELS, type Warmth } from "@/lib/reply-reader";

export type TaskRow = {
  id: string;
  queue: string;
  influencerId: string;
  name: string;
  handle: string | null;
  followers: number | null;
  status: CreatorStatus;
  nextAction: string;
  dueAt: Date | null;
  lateDays: number;
  /** The one word on the button. */
  verb: string;
  /** Rose button for the things that unblock a creator; white for the rest. */
  primary: boolean;
  /** Where the non-message verbs go. */
  href: string | null;
  profiles: { id: string; platform: Platform; handle: string }[];
  email: string | null;
  amazonCreator: boolean;
  blockedReason: string | null;
  purpose: TemplatePurpose | null;
  /** The campaign the step belongs to, for Rachna's pick. */
  campaignName?: string;
  /** The latest reply as Rachna read it: hot rows rise and get a flame. */
  warmth?: Warmth | null;
  readSummary?: string | null;
};

/** The icon on each verb, so the buttons read at a glance. */
export function verbIcon(verb: string, size = "size-3.5") {
  const props = { className: size, strokeWidth: 2.3 } as const;
  if (verb === "Reply") return <Reply {...props} />;
  if (verb === "Send link") return <Link2 {...props} />;
  if (verb === "Approve") return <Check {...props} />;
  if (verb === "Message") return <MessageCircle {...props} />;
  if (verb === "Review") return <Eye {...props} />;
  return null;
}

/**
 * Today's tasks: who, where they stand, what to do and how late it is, and the one button.
 * Hovering an avatar turns it into a checkbox, for copying names and handles in bulk.
 * The card decides the layout, not the window: four columns when it is wide, two lines when it is not.
 */
export function TaskList({ rows }: { rows: TaskRow[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const chosen = rows.filter((row) => selected.has(row.id));
  const selecting = selected.size > 0;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function copyHandles() {
    const text = chosen.map((row) => `${row.name}\t${row.handle ?? ""}\t${row.nextAction}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setNotice(`${chosen.length} copied.`);
    } catch {
      window.prompt("Copy:", text);
    }
  }

  return (
    <div className="@container">
      {selecting ? (
        <div className="flex flex-wrap items-center gap-2 border-b bg-primary-faint px-5 py-2.5 text-sm md:px-[22px]">
          <span className="font-bold text-foreground">{selected.size} selected</span>
          <Button size="xs" variant="outline" onClick={copyHandles}>
            Copy names and handles
          </Button>
          <button type="button" className="text-xs font-semibold text-muted-foreground hover:text-foreground" onClick={() => setSelected(new Set(rows.map((row) => row.id)))}>
            Select all
          </button>
          <button type="button" className="text-xs font-semibold text-muted-foreground hover:text-foreground" onClick={() => setSelected(new Set())}>
            Clear
          </button>
          {notice ? (
            <span role="status" className="ml-auto text-xs font-semibold text-success-text">
              {notice}
            </span>
          ) : null}
        </div>
      ) : null}
      {rows.map((row, index) => {
        const hot = row.warmth === "hot";
        const step = row.readSummary ?? row.nextAction;
        const ticked = selected.has(row.id);
        const when = (
          <span className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] font-bold", row.lateDays > 0 ? "text-danger-text" : "text-muted-foreground")} title={row.dueAt ? `Since ${formatDay(row.dueAt)}` : undefined}>
            {row.warmth ? (
              <span className={cn("inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11.5px] font-extrabold", hot ? "bg-danger-soft text-danger-text" : row.warmth === "warm" ? "bg-warning-soft text-warning-text" : "bg-surface-2 text-accent-text")}>
                {hot ? <Flame className="size-3" strokeWidth={2.5} /> : null}
                {WARMTH_LABELS[row.warmth]}
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" strokeWidth={2.3} />
              {row.lateDays === 0 ? "Due today" : row.lateDays === 1 ? "1 day late" : `${row.lateDays} days late`}
            </span>
          </span>
        );
        return (
          <div
            key={row.id}
            id={index === 0 ? "task-first" : undefined}
            data-rachna-point={`${row.verb}: ${row.name}`}
            className={cn(
              "group/row grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-[#f1f3f6] px-5 py-3.5 transition-colors last:border-b-0 hover:bg-[#fbfbfc] md:px-[22px] @min-[34rem]:grid-cols-[minmax(0,1.5fr)_118px_minmax(0,1.3fr)_104px]",
              hot && "bg-gradient-to-r from-[#fff5f7] to-surface",
              ticked && "bg-primary-faint",
            )}
          >
            <div className="flex min-w-0 items-center gap-3">
              <label className="relative shrink-0 cursor-pointer" title={`Select ${row.name}`}>
                <Avatar name={row.name} className={cn("transition-opacity group-hover/row:opacity-0", (selecting || ticked) && "opacity-0")} />
                <input
                  type="checkbox"
                  aria-label={`Select ${row.name}`}
                  checked={ticked}
                  onChange={() => toggle(row.id)}
                  className={cn("absolute inset-0 m-auto size-[18px] cursor-pointer accent-[var(--primary)] transition-opacity", selecting || ticked ? "opacity-100" : "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100")}
                />
              </label>
              <div className="min-w-0">
                <CreatorName id={row.influencerId} name={row.name} className="text-[14.5px] font-bold text-foreground hover:text-primary" />
                <div className="truncate text-[12.5px] font-medium text-muted-foreground">
                  {row.handle ?? (row.amazonCreator ? "Amazon Creator Connections" : (row.email ?? "No profile"))}
                  {row.followers !== null ? ` · ${formatCount(row.followers)}` : ""}
                </div>
                {/* A narrow card: stage, step and lateness under the name. */}
                <div className="mt-2 grid gap-1 @min-[34rem]:hidden">
                  <div className="flex flex-wrap items-center gap-2">
                    <CreatorStatusPill status={row.status} />
                    <span className="text-[13px] font-semibold text-foreground">{step}</span>
                  </div>
                  {when}
                </div>
              </div>
            </div>
            <div className="hidden @min-[34rem]:block">
              <CreatorStatusPill status={row.status} />
            </div>
            <div className="hidden min-w-0 gap-0.5 @min-[34rem]:grid">
              <span className="truncate text-[13.5px] font-semibold text-foreground" title={row.readSummary ? `Rachna: ${row.readSummary}` : row.nextAction}>
                {step}
              </span>
              {when}
            </div>
            <div className="text-right">
              {row.href ? (
                <Button asChild size="xs" variant={row.primary ? "action" : "outline"}>
                  <Link href={row.href}>
                    {verbIcon(row.verb)}
                    {row.verb}
                  </Link>
                </Button>
              ) : (
                <MessageButton
                  size="xs"
                  variant={row.primary ? "action" : "outline"}
                  label={row.verb}
                  icon={verbIcon(row.verb)}
                  target={{ campaignCreatorId: row.id, influencerName: row.name, status: row.status, profiles: row.profiles, email: row.email, amazonCreator: row.amazonCreator, blockedReason: row.blockedReason, purpose: row.purpose }}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
