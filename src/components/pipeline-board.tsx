"use client";

import type { CreatorStatus, Platform, TemplatePurpose } from "@prisma/client";
import { cn } from "cn";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updateCreatorStatus } from "@/actions/campaign-creators";
import { Avatar } from "@/components/avatar";
import { MessageButton } from "@/components/message-button";
import { formatCount, formatDay } from "@/lib/format";
import { LANES, type Lane } from "@/lib/pipeline";
import { CREATOR_STATUS_LABELS } from "@/lib/status";

export type BoardCard = {
  id: string;
  influencerId: string;
  name: string;
  handle: string | null;
  followers: number | null;
  status: CreatorStatus;
  nextAction: string | null;
  dueAt: Date | null;
  waitingOn: string | null;
  fitScore: number | null;
  owner: string | null;
  profiles: { id: string; platform: Platform; handle: string }[];
  blockedReason: string | null;
  purpose: TemplatePurpose | null;
};

const SHOWN = 6;
const DAY = 24 * 60 * 60 * 1000;

/** "Send the product selection link" -> "Product selection link": the chip has no room for the verb. */
function shorten(action: string): string {
  const short = action.replace(/^Send (the |a )?/, "").replace(/^Check the /, "").replace(/^Ask whether /, "Ask: ").replace(/^Review in the queue$/, "Review");
  return short.charAt(0).toUpperCase() + short.slice(1);
}

/** The chip on a card: what is due, in red when late; otherwise where the creator is. */
function chipFor(card: BoardCard, now: Date): { text: string; tone: "red" | "amber" | "blue" | "grey" } {
  if (card.dueAt && card.dueAt <= now && card.waitingOn !== "creator" && card.nextAction) {
    const late = Math.floor((now.getTime() - card.dueAt.getTime()) / DAY);
    return { text: late > 0 ? `${shorten(card.nextAction)} · ${late === 1 ? "1 day" : `${late} days`} late` : `${shorten(card.nextAction)} · today`, tone: late > 0 ? "red" : "amber" };
  }
  if (card.status === "scored" && card.fitScore !== null) return { text: `Fit ${card.fitScore} · review`, tone: card.fitScore >= 70 ? "blue" : "grey" };
  if (card.status === "replied") return { text: "Replied", tone: "blue" };
  if (card.dueAt && card.dueAt > now && card.nextAction) return { text: `${shorten(card.nextAction)} · ${formatDay(card.dueAt)}`, tone: "grey" };
  return { text: CREATOR_STATUS_LABELS[card.status], tone: "grey" };
}

const CHIP: Record<"red" | "amber" | "blue" | "grey", string> = {
  red: "bg-danger-soft text-danger-text",
  amber: "bg-warning-soft text-warning-text",
  blue: "bg-info-soft text-info-text",
  grey: "bg-surface-2 text-accent-text",
};

/**
 * Five lanes of cards. Drag a card onto a lane to move the creator to that
 * lane's first status; the change is shown at once and written through the
 * same action the status menu uses, so it is logged like any other change.
 */
export function PipelineBoard({ cards, closed, reviewHref, now }: { cards: BoardCard[]; closed: { status: CreatorStatus; count: number }[]; reviewHref: string; now: Date }) {
  const router = useRouter();
  const [moved, setMoved] = useState<Record<string, CreatorStatus>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [over, setOver] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const statusOf = (card: BoardCard) => moved[card.id] ?? card.status;

  function drop(lane: Lane, id: string) {
    const card = cards.find((item) => item.id === id);
    setOver(null);
    setDragging(null);
    if (!card || lane.statuses.includes(statusOf(card))) return;
    setMoved((current) => ({ ...current, [id]: lane.dropTo }));
    startTransition(async () => {
      const result = await updateCreatorStatus(id, lane.dropTo);
      if (!result.ok) {
        setError(result.error);
        setMoved((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
      }
      router.refresh();
    });
  }

  const closedTotal = closed.reduce((sum, row) => sum + row.count, 0);
  const dueCount = cards.filter((card) => card.dueAt && card.dueAt <= now && card.waitingOn !== "creator").length;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>
          {cards.length + closedTotal} {cards.length + closedTotal === 1 ? "creator" : "creators"}
          {dueCount > 0 ? ` · ${dueCount} need you today` : ""}
        </span>
        <span className="ml-auto hidden md:inline">Drag a card to the next lane, or open the creator and use Move.</span>
        {error ? (
          <span role="alert" className="text-danger-text">
            {error}
          </span>
        ) : null}
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {LANES.map((lane) => {
          const inLane = cards.filter((card) => lane.statuses.includes(statusOf(card))).sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity) || a.name.localeCompare(b.name));
          const visible = expanded[lane.key] ? inLane : inLane.slice(0, SHOWN);
          return (
            <section
              key={lane.key}
              aria-label={lane.label}
              onDragOver={(event) => {
                event.preventDefault();
                if (over !== lane.key) setOver(lane.key);
              }}
              onDragLeave={() => setOver((current) => (current === lane.key ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                const id = event.dataTransfer.getData("text/plain") || dragging;
                if (id) drop(lane, id);
              }}
              className="min-w-0"
            >
              <h3 className="mb-2 flex items-center gap-2 px-1 text-sm font-bold">
                <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: lane.color }} />
                {lane.label}
                <span className="font-semibold text-muted-foreground">{inLane.length}</span>
              </h3>
              <div className={cn("grid min-h-[160px] content-start gap-2.5 rounded-xl p-2.5 transition-colors", over === lane.key ? "bg-primary-soft/60 ring-2 ring-primary/40" : "bg-[#eceef2]")}>
                {visible.map((card) => {
                  const chip = chipFor({ ...card, status: statusOf(card) }, now);
                  const late = chip.tone === "red";
                  const candidate = statusOf(card) === "discovered" || statusOf(card) === "scored";
                  const messageDue = chip.tone === "red" || chip.tone === "amber" || statusOf(card) === "replied";
                  return (
                    <article
                      key={card.id}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData("text/plain", card.id);
                        event.dataTransfer.effectAllowed = "move";
                        setDragging(card.id);
                      }}
                      onDragEnd={() => setDragging(null)}
                      className={cn("card grid cursor-grab gap-2 p-3 active:cursor-grabbing", late && "border-l-[3px] border-l-danger-text", dragging === card.id && "opacity-50")}
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Avatar name={card.name} className="size-8" />
                        <div className="min-w-0">
                          <Link href={`/influencers/${card.influencerId}`} className="block truncate text-sm font-semibold hover:text-primary-text">
                            {card.name}
                          </Link>
                          <p className="truncate text-xs text-muted-foreground">
                            {card.handle ?? "No profile"}
                            {card.followers !== null ? ` · ${formatCount(card.followers)}` : ""}
                            {card.owner ? ` · ${card.owner}` : ""}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className={cn("inline-flex min-w-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold", CHIP[chip.tone])}>
                          <span className="truncate">{chip.text}</span>
                        </span>
                        {candidate ? (
                          <Link href={reviewHref} className="link shrink-0 text-xs">
                            Review
                          </Link>
                        ) : card.nextAction?.startsWith("Approve") ? (
                          <Link href="/orders?status=needs_approval" className="link shrink-0 text-xs">
                            Approve
                          </Link>
                        ) : card.nextAction?.startsWith("Check the post") ? (
                          <Link href={`/influencers/${card.influencerId}#content`} className="link shrink-0 text-xs">
                            Open
                          </Link>
                        ) : messageDue ? (
                          <MessageButton
                            size="xs"
                            variant="outline"
                            label={statusOf(card) === "replied" ? "Reply" : "Message"}
                            target={{ campaignCreatorId: card.id, influencerName: card.name, status: statusOf(card), profiles: card.profiles, blockedReason: card.blockedReason, purpose: card.purpose }}
                          />
                        ) : null}
                      </div>
                    </article>
                  );
                })}
                {inLane.length > SHOWN ? (
                  <button type="button" onClick={() => setExpanded((current) => ({ ...current, [lane.key]: !current[lane.key] }))} className="px-1 py-1 text-left text-xs font-semibold text-muted-foreground hover:text-foreground">
                    {expanded[lane.key] ? "Show fewer" : `Show ${inLane.length - SHOWN} more`}
                  </button>
                ) : null}
                {lane.key === "done" && closedTotal > 0 ? (
                  <div className="grid gap-1 border-t border-border-strong/50 pt-2 text-xs">
                    {closed.map((row) => (
                      <Link key={row.status} href={`?view=list&status=${row.status}`} className="flex justify-between rounded px-1 py-0.5 text-accent-text hover:bg-surface hover:text-foreground">
                        <span>{CREATOR_STATUS_LABELS[row.status]}</span>
                        <b>{row.count}</b>
                      </Link>
                    ))}
                  </div>
                ) : null}
                {inLane.length === 0 && !(lane.key === "done" && closedTotal > 0) ? <p className="px-1 py-2 text-xs text-muted-foreground">Nobody here.</p> : null}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
