"use client";

import type { CreatorStatus, Platform, TemplatePurpose } from "@prisma/client";
import { cn } from "cn";
import { ChevronRight, Flame } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updateCreatorStatus } from "@/actions/campaign-creators";
import { Avatar } from "@/components/avatar";
import { CreatorName } from "@/components/creator-card";
import { useRachna } from "@/components/rachna/rachna";
import { MessageButton } from "@/components/message-button";
import { Button } from "@/components/ui/button";
import { formatCount } from "@/lib/format";
import { LANES, type Lane } from "@/lib/pipeline";
import type { Warmth } from "@/lib/reply-reader";
import { CREATOR_STATUS_LABELS, CREATOR_STATUS_TONES, TONE_CLASSES } from "@/lib/status";

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

type Tone = "red" | "amber" | "blue" | "grey" | "green" | "violet";

const CHIP: Record<Tone, string> = {
  red: "bg-danger-soft text-danger-text",
  amber: "bg-warning-soft text-warning-text",
  blue: "bg-info-soft text-info-text",
  grey: "bg-surface-2 text-accent-text",
  green: "bg-success-soft text-success-text",
  violet: "bg-violet-soft text-violet-text",
};

/** The one chip on a card: how late, how warm, or where the creator is, in two or three words. */
function chipFor(card: BoardCard, now: Date): { text: string; tone: Tone } {
  const dueNow = card.dueAt !== null && card.dueAt <= now && card.waitingOn !== "creator" && card.nextAction !== null;
  const late = dueNow && card.dueAt ? Math.floor((now.getTime() - card.dueAt.getTime()) / DAY) : 0;
  if (card.warmth === "hot" && dueNow) return { text: "Hot", tone: "red" };
  if (card.warmth === "warm" && dueNow) return { text: late > 0 ? `Warm · ${late}d late` : "Warm", tone: "amber" };
  if (dueNow && late > 0) return { text: late === 1 ? "1 day late" : `${late} days late`, tone: "red" };
  if (card.status === "address_collected") return { text: "Approve gift", tone: "violet" };
  if (card.status === "product_shipped") return { text: "In transit", tone: "amber" };
  if (card.status === "scored" && card.fitScore !== null) return { text: `Fit ${card.fitScore}`, tone: card.fitScore >= 70 ? "blue" : "grey" };
  if (dueNow) return { text: "Due today", tone: "amber" };
  if (card.status === "replied") return { text: "Replied", tone: "blue" };
  if (card.dueAt && card.dueAt > now) {
    const days = Math.ceil((card.dueAt.getTime() - now.getTime()) / DAY);
    return { text: days <= 1 ? "Due tomorrow" : `Due in ${days} days`, tone: "grey" };
  }
  if (card.status === "approved" || card.status === "outreach_scheduled") return { text: "First message", tone: "grey" };
  return { text: CREATOR_STATUS_LABELS[card.status], tone: "grey" };
}

/** The verb on a card, when there is something to do now; "Track" and "Remind" while waiting on a parcel or a post. */
function verbFor(card: BoardCard, due: boolean): string | null {
  if (card.status === "discovered" || card.status === "scored") return "Review";
  if (card.status === "product_shipped") return "Track";
  if (!due) return card.status === "content_expected" ? "Remind" : null;
  if (card.status === "replied") return "Reply";
  if (card.nextAction?.startsWith("Send the product selection")) return "Send link";
  if (card.nextAction?.startsWith("Approve") || card.status === "address_collected") return "Approve";
  if (card.nextAction?.startsWith("Check the post")) return "Open";
  return "Message";
}

const PRIMARY_VERBS = new Set(["Reply", "Send link", "Approve"]);

/**
 * Four working lanes of cards, and a Done strip above them. Drag a card onto a
 * lane (or onto Done) to move the creator to that lane's first status; the
 * change is shown at once and written through the same action the status menu
 * uses, so it is logged like any other change.
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

  // The same three handlers make a lane, or the Done strip, a place to drop a card.
  const dropZone = (lane: Lane) => ({
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault();
      if (over !== lane.key) setOver(lane.key);
    },
    onDragLeave: () => setOver((current) => (current === lane.key ? null : current)),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      const id = event.dataTransfer.getData("text/plain") || dragging;
      if (id) drop(lane, id);
    },
  });

  const doneLane = LANES.find((lane) => lane.key === "done")!;
  const workLanes = LANES.filter((lane) => lane.key !== "done");
  const movedToDone = cards.filter((card) => doneLane.statuses.includes(statusOf(card)) && !doneLane.statuses.includes(card.status)).length;
  const doneTotal = done.reduce((sum, row) => sum + row.count, 0) + movedToDone;

  return (
    <div className="grid gap-4">
      {error ? (
        <p role="alert" className="text-sm font-semibold text-danger-text">
          {error}
        </p>
      ) : null}

      <section
        aria-label="Done"
        {...dropZone(doneLane)}
        className={cn("flex flex-wrap items-center gap-2.5 rounded-2xl border bg-surface px-4 py-3 transition-colors", over === doneLane.key && "border-primary bg-primary-faint ring-[3px] ring-primary/15")}
      >
        <span className="label">Done</span>
        <b className="text-base font-extrabold text-foreground tabular-nums">{doneTotal.toLocaleString("en-US")}</b>
        {done.map((row) => (
          <Link key={row.status} href={`${listHref}&status=${row.status}`} className={cn("inline-flex h-6 items-center rounded-full px-2.5 text-xs font-extrabold hover:underline", TONE_CLASSES[CREATOR_STATUS_TONES[row.status]])}>
            {CREATOR_STATUS_LABELS[row.status]} {row.count + (doneLane.statuses.includes(row.status) && row.status === doneLane.dropTo ? movedToDone : 0)}
          </Link>
        ))}
        {doneTotal === 0 ? <span className="text-sm font-medium text-muted-foreground">Nobody here yet. Drop a card to mark it done.</span> : null}
        <span className="flex-1" />
        <Link href={listHref} className="inline-flex items-center gap-1 text-[13px] font-bold text-primary hover:underline">
          See all
          <ChevronRight className="size-4" strokeWidth={2.4} />
        </Link>
      </section>

      <div id="board-lanes" className="grid grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-cols-4">
        {workLanes.map((lane) => {
          const inLane = cards
            .filter((card) => lane.statuses.includes(statusOf(card)))
            .sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity) || a.name.localeCompare(b.name));
          const visible = expanded[lane.key] ? inLane : inLane.slice(0, SHOWN);
          return (
            <section key={lane.key} aria-label={lane.label} {...dropZone(lane)} className="min-w-0">
              <div className={cn("grid min-h-[160px] grid-cols-1 content-start gap-2.5 rounded-[18px] p-3 transition-colors", over === lane.key ? "bg-primary-faint ring-[3px] ring-primary/20" : "bg-[#eef0f4]")}>
                <h3 className="flex items-center gap-2 px-1 pt-1 pb-1.5 text-[14px] font-extrabold">
                  <span aria-hidden className="size-[9px] rounded-full" style={{ backgroundColor: lane.color }} />
                  {lane.label}
                  <span className="inline-grid h-[22px] min-w-[26px] place-items-center rounded-full bg-surface px-2 text-xs font-extrabold text-accent-text tabular-nums">{inLane.length}</span>
                </h3>
                {visible.map((card) => {
                  const status = statusOf(card);
                  const chip = chipFor({ ...card, status }, now);
                  const dueNow = card.dueAt !== null && card.dueAt <= now && card.waitingOn !== "creator";
                  const late = chip.tone === "red" && chip.text !== "Hot";
                  const verb = verbFor({ ...card, status }, dueNow || status === "replied");
                  const href = verb === "Review" ? reviewHref : verb === "Approve" ? "/orders?status=needs_approval" : verb === "Open" ? `/influencers/${card.influencerId}#content` : verb === "Track" ? `/influencers/${card.influencerId}#gifts` : null;
                  const variant = verb && PRIMARY_VERBS.has(verb) ? "action" : "outline";
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
                      data-rachna-point={dueNow && verb ? `${verb}: ${card.name}` : undefined}
                      className={cn(
                        "grid min-w-0 cursor-grab grid-cols-1 gap-3 rounded-[14px] border border-transparent bg-surface p-[13px] shadow-[0_1px_2px_rgba(15,23,42,0.06),0_2px_6px_rgba(15,23,42,0.04)] transition-all duration-150 hover:-translate-y-0.5 hover:border-[#f3cdd9] hover:shadow-[var(--shadow-lift)] active:cursor-grabbing",
                        card.warmth === "hot" && dueNow ? "border-l-[3px] border-l-primary" : late && "border-l-[3px] border-l-[#e11d48]",
                        dragging === card.id && "opacity-50",
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <Avatar name={card.name} className="size-[34px] text-[11.5px]" />
                        <div className="min-w-0">
                          <CreatorName id={card.influencerId} name={card.name} className="text-[14px] font-bold text-foreground hover:text-primary" />
                          <p className="truncate text-[12.5px] font-medium text-muted-foreground">
                            {card.handle ?? (card.amazonCreator ? "Amazon Creator Connections" : (card.email ?? "No profile"))}
                            {card.followers !== null ? ` · ${formatCount(card.followers)}` : ""}
                          </p>
                        </div>
                      </div>
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <span title={card.readSummary ?? card.nextAction ?? undefined} className={cn("inline-flex h-6 min-w-0 items-center gap-1 rounded-full px-2.5 text-xs font-extrabold", CHIP[chip.tone])}>
                          {chip.text === "Hot" ? <Flame className="size-3 shrink-0" strokeWidth={2.5} /> : null}
                          <span className="truncate">{chip.text}</span>
                        </span>
                        {verb && href ? (
                          <Button asChild size="xs" variant={variant}>
                            <Link href={href}>{verb}</Link>
                          </Button>
                        ) : verb ? (
                          <MessageButton
                            size="xs"
                            variant={variant}
                            label={verb}
                            target={{ campaignCreatorId: card.id, influencerName: card.name, status, profiles: card.profiles, email: card.email, amazonCreator: card.amazonCreator, blockedReason: card.blockedReason, purpose: card.purpose }}
                          />
                        ) : (
                          <span className="shrink-0 text-xs font-semibold text-muted-foreground">Waiting</span>
                        )}
                      </div>
                    </article>
                  );
                })}
                {inLane.length > SHOWN ? (
                  <button
                    type="button"
                    onClick={() => setExpanded((current) => ({ ...current, [lane.key]: !current[lane.key] }))}
                    className="h-9 rounded-xl border-[1.5px] border-dashed border-[#d5d9e0] text-[13px] font-bold text-muted-foreground transition-colors hover:border-primary/40 hover:bg-surface hover:text-foreground"
                  >
                    {expanded[lane.key] ? "Show fewer" : `+ ${inLane.length - SHOWN} more`}
                  </button>
                ) : null}
                {inLane.length === 0 ? <p className="px-1 py-2 text-[13px] font-medium text-muted-foreground">Nobody here.</p> : null}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
