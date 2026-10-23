"use client";

import type { CreatorStatus, Platform, TemplatePurpose } from "@prisma/client";
import { cn } from "cn";
import Link from "next/link";
import { useState } from "react";
import { Avatar } from "@/components/avatar";
import { MessageButton } from "@/components/message-button";
import { CreatorStatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { formatCount, formatDay } from "@/lib/format";

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
};

/** The flat list of today's tasks with a checkbox per row for copying handles in bulk. */
export function TaskList({ rows }: { rows: TaskRow[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  const chosen = rows.filter((row) => selected.has(row.id));

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
    <div>
      <div className="hidden grid-cols-[24px_minmax(0,1.5fr)_150px_minmax(0,1.7fr)_110px_104px] items-center gap-3 bg-surface-2/60 px-4 py-2 text-xs font-semibold text-muted-foreground md:grid">
        <input type="checkbox" aria-label="Select all tasks" checked={rows.length > 0 && selected.size === rows.length} onChange={(event) => setSelected(event.target.checked ? new Set(rows.map((row) => row.id)) : new Set())} />
        <span>Creator</span>
        <span>Stage</span>
        <span>Next step</span>
        <span>Due</span>
        <span />
      </div>
      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-b bg-primary-soft/40 px-4 py-2 text-sm">
          <span className="font-semibold">{selected.size} selected</span>
          <Button size="sm" variant="outline" onClick={copyHandles}>
            Copy names and handles
          </Button>
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setSelected(new Set())}>
            Clear
          </button>
          {notice ? (
            <span role="status" className="ml-auto text-xs text-success-text">
              {notice}
            </span>
          ) : null}
        </div>
      ) : null}
      {rows.map((row, index) => (
        <div key={row.id} id={index === 0 ? "task-first" : undefined} className={cn("grid gap-x-3 gap-y-2 border-t px-4 py-3 hover:bg-surface-2/40 md:grid-cols-[24px_minmax(0,1.5fr)_150px_minmax(0,1.7fr)_110px_104px] md:items-center md:py-2.5", selected.has(row.id) && "bg-primary-soft/20")}>
          <input type="checkbox" aria-label={`Select ${row.name}`} checked={selected.has(row.id)} onChange={() => toggle(row.id)} className="max-md:hidden" />
          <div className="flex min-w-0 items-center gap-2.5">
            <Avatar name={row.name} />
            <div className="min-w-0">
              <Link href={`/influencers/${row.influencerId}`} className="block truncate font-semibold hover:text-primary-text">
                {row.name}
              </Link>
              <div className="truncate text-xs text-muted-foreground">
                {row.handle ?? (row.amazonCreator ? "Amazon Creator Connections" : (row.email ?? "No profile"))}
                {row.followers !== null ? ` · ${formatCount(row.followers)}` : ""}
              </div>
            </div>
          </div>
          <div>
            <CreatorStatusPill status={row.status} />
          </div>
          <div className="text-sm max-md:text-muted-foreground">{row.nextAction}</div>
          <div>
            <span title={row.dueAt ? `Since ${formatDay(row.dueAt)}` : undefined} className={cn("chip border-transparent", row.lateDays > 0 ? "bg-danger-soft text-danger-text" : row.primary ? "bg-danger-soft text-danger-text" : "bg-surface-2")}>
              {row.lateDays === 0 ? "Today" : row.lateDays === 1 ? "1 day late" : `${row.lateDays} days late`}
            </span>
          </div>
          <div className="md:text-right">
            {row.href ? (
              <Button asChild size="sm" variant={row.primary ? "action" : "outline"}>
                <Link href={row.href}>{row.verb}</Link>
              </Button>
            ) : (
              <MessageButton
                size="sm"
                variant={row.primary ? "action" : "outline"}
                label={row.verb}
                target={{ campaignCreatorId: row.id, influencerName: row.name, status: row.status, profiles: row.profiles, email: row.email, amazonCreator: row.amazonCreator, blockedReason: row.blockedReason, purpose: row.purpose }}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
