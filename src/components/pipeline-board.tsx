"use client";

import type { CreatorStatus, Platform, TemplatePurpose } from "@prisma/client";
import { cn } from "cn";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updateCreatorStatus } from "@/actions/campaign-creators";
import { Avatar } from "@/components/avatar";
import { CreatorName } from "@/components/creator-card";
import { useRachna } from "@/components/rachna/rachna";
import { MessageButton } from "@/components/message-button";
import { formatCount, formatDay } from "@/lib/format";
import { LANES, type Lane } from "@/lib/pipeline";
import type { Warmth } from "@/lib/reply-reader";
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
  profiles: { id: string; platform: Platform; handle: string }[];
  email: string | null;
  amazonCreator: boolean;
  blockedReason: string | null;
  purpose: TemplatePurpose | null;
  /** The latest reply as Rachna read it. */
  warmth: Warmth | null;
  readSummary: string | null;
};

const SHOWN = 3;
const DAY = 24 * 60 * 60 * 1000;

/** "Send the product selection link" -> "Product selection link": the chip has no room for the verb. */
function shorten(action: string): string {
  const short = action.replace(/^Send (the |a )?/, "").replace(/^Check the /, "").replace(/^Ask whether /, "Ask: ").replace(/^Review in the queue$/, "Review");
  return short.charAt(0).toUpperCase() + short.slice(1);
}

/** The chip on a card: what is due, in red when late; otherwise where the creator is. */
function chipFor(card: BoardCard, now: Date): { text: string; tone: "red" | "amber" | "blue" | "grey" } {
  // A reply Rachna read as hot or warm: the chip says so, in front of what is due.
  if (card.warmth === "hot" && card.dueAt && card.dueAt <= now && card.waitingOn !== "creator" && card.nextAction) return { text: `Hot · ${shorten(card.nextAction)}`, tone: "red" };
  if (card.warmth === "warm" && card.dueAt && card.dueAt <= now && card.waitingOn !== "creator" && card.nextAction) return { text: `Warm · ${shorten(card.nextAction)}`, tone: "amber" };
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

/** The verb on the right of a card, when there is something to do now. */
function verbFor(card: BoardCard, due: boolean): string | null {
  if (card.status === "discovered" || card.status === "scored") return "Review";
  if (!due) return null;
  if (card.status === "replied") return "Reply";
  if (card.nextAction?.startsWith("Send the product selection")) return "Send link";
  if (card.nextAction?.startsWith("Approve")) return "Approve";
  if (card.nextAction?.startsWith("Check the post")) return "Open";
  return "Message";
}

/**
 * Five lanes of cards. Drag a card onto a lane to move the creator to that
 * lane's first status; the change is shown at once and written through the
 * same action the status menu uses, so it is logged like any other change.
 * The Done lane shows counts only: posted, completed and every closed outcome.
 */
export function PipelineBoard({ cards, done, reviewHref, listHref, now }: { cards: BoardCard[]; done: { status: CreatorStatus; count: number }[]; reviewHref: string; listHref: string; now: Date }) {
  const router = useRouter();
  const [moved, setMoved] = useState<Record<string, CreatorStatus>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [over, setOver] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const rachna = useRachna();

  const statusOf = (card: BoardCard) => moved[card.id] ?? card.status;

  function drop(lane: Lane, id: string) {
    const card = cards.find((item) => item.id === id);
    setOver(null);
    setDragging(null);
    if (!card || lane.statuses.includes(statusOf(card))) return;
    setMoved((current) => ({ ...current, [id]: lane.dropTo }));
    startTransition(async () => {
      const result = await updateCreatorStatus(id, lane.dropTo);
      if (result.ok) rachna?.nudge(id, lane.dropTo);
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

  const doneTotal = done.reduce((sum, row) => sum + row.count, 0);

  return (
    <div>
      {error ? (
        <p role="alert" className="mb-3 text-sm text-danger-text">
          {error}
        </p>
      ) : null}
      <div id="board-lanes" className="grid gap-4 md:grid-cols-2 xl:grid-cols-[repeat(4,minmax(0,1fr))_200px]">
        {LANES.map((lane) => {
          const isDone = lane.key === "done";
          const inLane = isDone
            ? []
            : cards.filter((card) => lane.statuses.includes(statusOf(card))).sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity) || a.name.localeCompare(b.name));
          const visible = expanded[lane.key] ? inLane : inLane.slice(0, SHOWN);
          const movedHere = isDone ? cards.filter((card) => lane.statuses.includes(statusOf(card)) && !lane.statuses.includes(card.status)).length : 0;
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
                <span className="font-semibold text-muted-foreground">{isDone ? doneTotal + movedHere : inLane.length}</span>
              </h3>
              <div className={cn("grid grid-cols-1 content-start gap-2.5 rounded-xl p-3 transition-colors", isDone ? "min-h-0" : "min-h-[420px]", over === lane.key ? "bg-primary-soft/60 ring-2 ring-primary/40" : "bg-[#eceef2]")}>
                {visible.map((card) => {
                  const chip = chipFor({ ...card, status: statusOf(card) }, now);
                  const late = chip.tone === "red";
                  const due = chip.tone === "red" || chip.tone === "amber" || statusOf(card) === "replied";
                  const verb = verbFor({ ...card, status: statusOf(card) }, due);
                  const href = verb === "Review" ? reviewHref : verb === "Approve" ? "/orders?status=needs_approval" : verb === "Open" ? `/influencers/${card.influencerId}#content` : null;
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
                      data-rachna-point={due && verb ? `${verb}: ${card.name}` : undefined}
                      className={cn("card grid min-w-0 grid-cols-1 cursor-grab gap-2.5 p-3.5 active:cursor-grabbing", late && "border-l-[3px] border-l-danger-text", card.warmth === "hot" && !late && "border-l-[3px] border-l-primary", dragging === card.id && "opacity-50")}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <Avatar name={card.name} className="size-9" />
                        <div className="min-w-0">
                          <CreatorName id={card.influencerId} name={card.name} className="block truncate text-sm font-semibold hover:text-primary-text" />
                          <p className="truncate text-xs text-muted-foreground">
                            {card.handle ?? (card.amazonCreator ? "Amazon Creator Connections" : (card.email ?? "No profile"))}
                            {card.followers !== null ? ` · ${formatCount(card.followers)}` : ""}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 flex-1 overflow-hidden">
                          <span title={card.readSummary ?? undefined} className={cn("inline-flex max-w-full min-w-0 items-center rounded-full px-2 py-0.5 text-[11px] font-semibold", CHIP[chip.tone])}>
                            <span className="truncate">{chip.text}</span>
                          </span>
                        </span>
                        {verb && href ? (
                          <Link href={href} className="link shrink-0 text-xs">
                            {verb}
                          </Link>
                        ) : verb ? (
                          <MessageButton
                            size="xs"
                            variant="link"
                            className="h-auto px-0 text-xs"
                            label={verb}
                            target={{ campaignCreatorId: card.id, influencerName: card.name, status: statusOf(card), profiles: card.profiles, email: card.email, amazonCreator: card.amazonCreator, blockedReason: card.blockedReason, purpose: card.purpose }}
                          />
                        ) : (
                          <span className="shrink-0 text-xs text-muted-foreground">Waiting</span>
                        )}
                      </div>
                    </article>
                  );
                })}
                {inLane.length > SHOWN ? (
                  <button type="button" onClick={() => setExpanded((current) => ({ ...current, [lane.key]: !current[lane.key] }))} className="px-1 py-1 text-left text-xs font-semibold text-muted-foreground hover:text-foreground">
                    {expanded[lane.key] ? "Show fewer" : `Show ${inLane.length - SHOWN} more`}
                  </button>
                ) : null}
                {isDone ? (
                  <div className="grid gap-1 text-sm">
                    {done.map((row) => (
                      <Link key={row.status} href={`${listHref}&status=${row.status}`} className="flex justify-between rounded px-1 py-1 hover:bg-surface">
                        <span>{CREATOR_STATUS_LABELS[row.status]}</span>
                        <b>{row.count + (lane.statuses.includes(row.status) ? movedHere : 0)}</b>
                      </Link>
                    ))}
                    {doneTotal === 0 && movedHere === 0 ? <p className="px-1 py-1 text-xs text-muted-foreground">Nobody here yet.</p> : null}
                    <Link href={listHref} className="px-1 pt-2 text-xs font-semibold text-muted-foreground hover:text-foreground">
                      Show all
                    </Link>
                  </div>
                ) : inLane.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-muted-foreground">Nobody here.</p>
                ) : null}
              </div>
            </section>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-muted-foreground">Drag a card to the next column, or open the creator and press Move. Outcomes like not interested or on hold are under Move, so the board stays five columns.</p>
    </div>
  );
}
