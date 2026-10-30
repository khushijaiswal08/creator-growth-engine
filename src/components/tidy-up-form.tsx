"use client";

import { cn } from "cn";
import { Sparkles, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { applyTidyUp, undoTidy } from "@/actions/tidy-up";
import { useRachna } from "@/components/rachna/rachna";
import { Button } from "@/components/ui/button";
import { formatShortDay } from "@/lib/format";
import type { TidyHistoryEntry } from "@/lib/tidy-up";
import { TIDY_ACTIONS, TIDY_CHUNK, type TidyAction, type TidyGroupKey } from "@/lib/tidy-up-rules";

export type TidyGroupView = {
  key: TidyGroupKey;
  title: string;
  about: string;
  actions: TidyAction[];
  rows: { id: string; name: string; campaign: string; status: string; lastTouch: Date | null }[];
};

const SHOWN = 8;

/**
 * The tidy-up preview: one card per group, every creator it would touch,
 * a choice per group, then Apply. Apply sends the previewed ids in chunks,
 * so a big backlog never runs into the server's time limit.
 */
export function TidyUpForm({ days, brand, groups, history }: { days: number; brand: string | null; groups: TidyGroupView[]; history: TidyHistoryEntry[] }) {
  const router = useRouter();
  const rachna = useRachna();
  const [pending, startTransition] = useTransition();
  const [choice, setChoice] = useState<Record<string, TidyAction>>(() => Object.fromEntries(groups.map((group) => [group.key, group.actions[0]])));
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; refused: boolean } | null>(null);

  const planned = groups.filter((group) => group.rows.length > 0 && choice[group.key] !== "leave");
  const total = planned.reduce((sum, group) => sum + group.rows.length, 0);

  function apply() {
    const lines = planned.map((group) => `${group.rows.length} × ${TIDY_ACTIONS[choice[group.key]].label.toLowerCase()} (${group.title.toLowerCase()})`);
    if (!window.confirm(`This changes ${total} ${total === 1 ? "creator" : "creators"}:\n\n${lines.join("\n")}\n\nNothing is sent, and you can undo it afterwards. Go ahead?`)) return;
    startTransition(async () => {
      setNotice(null);
      let tidyUpId: string | null = null;
      let changed = 0;
      let skipped = 0;
      let done = 0;
      try {
        for (const group of planned) {
          for (let start = 0; start < group.rows.length; start += TIDY_CHUNK) {
            // A call that runs out of time hands back the ids it did not reach; they go again.
            let ids = group.rows.slice(start, start + TIDY_CHUNK).map((row) => row.id);
            for (let round = 0; ids.length > 0 && round < 20; round++) {
              setProgress(`Working… ${done} of ${total}`);
              const result = await applyTidyUp({ days, group: group.key, action: choice[group.key], ids, tidyUpId, brand });
              if (!result.ok) throw new Error(result.error);
              tidyUpId = result.tidyUpId ?? tidyUpId;
              changed += result.changed;
              skipped += result.skipped;
              done += ids.length - result.pending.length;
              ids = result.pending;
            }
          }
        }
        setNotice({ text: `Done: ${changed} changed${skipped ? `, ${skipped} skipped because someone worked on them since the preview` : ""}. Home shows only what is left. You can undo this below.`, refused: false });
      } catch (error) {
        setNotice({ text: `Stopped after ${changed} changes: ${error instanceof Error ? error.message : "the connection dropped"}. What was done is listed below and can be undone.`, refused: true });
      } finally {
        setProgress(null);
        // The queues shrank by housekeeping, not by work: today's quests start again from the new counts.
        rachna?.restartQuests();
        router.refresh();
      }
    });
  }

  function undo(id: string) {
    if (!window.confirm("Put every creator this tidy-up changed back where they were? Anyone the team has worked on since stays as they are now.")) return;
    startTransition(async () => {
      setNotice(null);
      let restored = 0;
      let kept = 0;
      try {
        for (let round = 0; round < 100; round++) {
          setProgress(`Undoing… ${restored + kept} so far`);
          const result = await undoTidy(id);
          if (!result.ok) throw new Error(result.error);
          restored += result.restored;
          kept += result.kept;
          if (result.left === 0) break;
        }
        setNotice({ text: `Undone: ${restored} put back${kept ? `, ${kept} left as they are because the team worked on them since` : ""}.`, refused: false });
      } catch (error) {
        setNotice({ text: `Undo stopped after ${restored}: ${error instanceof Error ? error.message : "the connection dropped"}. Press Undo again to finish.`, refused: true });
      } finally {
        setProgress(null);
        // The queues shrank by housekeeping, not by work: today's quests start again from the new counts.
        rachna?.restartQuests();
        router.refresh();
      }
    });
  }

  const withRows = groups.filter((group) => group.rows.length > 0);
  return (
    <div className="grid gap-4">
      {withRows.length === 0 ? (
        <section className="card px-5 py-10 text-center font-medium text-muted-foreground">Nothing older than {days} days is waiting on Home. All tidy.</section>
      ) : (
        withRows.map((group) => {
          const expanded = open.has(group.key);
          const rows = expanded ? group.rows : group.rows.slice(0, SHOWN);
          return (
            <section key={group.key} className="card overflow-hidden">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
                <div className="min-w-0">
                  <h2 className="text-[15px] font-bold">
                    {group.title} <span className="font-semibold text-muted-foreground">· {group.rows.length}</span>
                  </h2>
                  <p className="mt-0.5 max-w-2xl text-xs text-muted-foreground">{group.about}</p>
                </div>
                <fieldset className="flex flex-wrap gap-1.5" disabled={pending}>
                  <legend className="sr-only">What to do with {group.title.toLowerCase()}</legend>
                  {group.actions.map((action) => (
                    <label key={action} className={cn("chip cursor-pointer", choice[group.key] === action && "border-primary bg-primary-faint text-primary-text")}>
                      <input type="radio" className="sr-only" name={`tidy-${group.key}`} value={action} checked={choice[group.key] === action} onChange={() => setChoice((current) => ({ ...current, [group.key]: action }))} />
                      {TIDY_ACTIONS[action].label}
                    </label>
                  ))}
                </fieldset>
              </div>
              <ul className="divide-y divide-[#f1f3f6] text-sm">
                {rows.map((row) => (
                  <li key={row.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 px-5 py-2">
                    <span className="min-w-0">
                      <span className="font-semibold">{row.name}</span> <span className="text-xs text-muted-foreground">· {row.campaign} · {row.status}</span>
                    </span>
                    <span className="text-xs whitespace-nowrap text-muted-foreground">{row.lastTouch ? `Last touched ${formatShortDay(row.lastTouch)}` : "Not touched since the import"}</span>
                  </li>
                ))}
              </ul>
              {group.rows.length > SHOWN ? (
                <button
                  type="button"
                  className="link w-full border-t px-5 py-2.5 text-left text-xs font-semibold"
                  onClick={() =>
                    setOpen((current) => {
                      const next = new Set(current);
                      if (next.has(group.key)) next.delete(group.key);
                      else next.add(group.key);
                      return next;
                    })
                  }
                >
                  {expanded ? "Show fewer" : `Show all ${group.rows.length}`}
                </button>
              ) : null}
            </section>
          );
        })
      )}

      {withRows.length > 0 ? (
        <div className="card sticky bottom-3 flex flex-wrap items-center gap-3 px-5 py-3">
          <Button variant="action" disabled={pending || total === 0} onClick={apply}>
            <Sparkles className="size-4" /> {total === 0 ? "Nothing chosen" : `Apply to ${total} ${total === 1 ? "creator" : "creators"}`}
          </Button>
          <span className="text-xs text-muted-foreground">Nothing is sent to anyone. Every change is logged and can be undone.</span>
          {progress ? <span className="text-xs font-semibold">{progress}</span> : null}
        </div>
      ) : null}

      {notice ? (
        <p role={notice.refused ? "alert" : "status"} className={cn("text-sm", notice.refused ? "font-semibold text-danger-text" : "text-success-text")}>
          {notice.text}
        </p>
      ) : null}

      {history.length > 0 ? (
        <section className="card overflow-hidden">
          <h2 className="border-b px-5 py-3 text-[15px] font-bold">Recent tidy-ups</h2>
          <ul className="divide-y divide-[#f1f3f6] text-sm">
            {history.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-2.5">
                <span>
                  <span className="font-semibold">{formatShortDay(entry.createdAt)}</span> · {entry.by} · older than {entry.days} days · {entry.summary}
                </span>
                {entry.undone ? (
                  <span className="text-xs text-muted-foreground">Undone</span>
                ) : (
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => undo(entry.id)}>
                    <Undo2 className="size-4" /> Undo
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
