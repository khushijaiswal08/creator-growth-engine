"use client";

import { Flame } from "lucide-react";
import Link from "next/link";
import { CreatorName } from "@/components/creator-card";
import { MessageButton } from "@/components/message-button";
import { RachnaPortrait, useRachna } from "@/components/rachna/rachna";
import { verbIcon, type TaskRow } from "@/components/task-list";
import { Button } from "@/components/ui/button";
import { daysLateText, formatCount } from "@/lib/format";
import { firstName } from "@/lib/template";

/** The first half of the headline: "Answer Meilyn first.", "Approve Pamy's gift." */
function whatToDo(verb: TaskRow["verb"], first: string): string {
  if (verb === "Reply") return `Answer ${first} first.`;
  if (verb === "Send link") return `Send ${first} the selection link.`;
  if (verb === "Approve") return `Approve ${first}'s gift.`;
  if (verb === "Review") return `Review ${first} first.`;
  if (verb === "Message") return `Message ${first} first.`;
  return `Check on ${first} first.`;
}

/** "Answer Meilyn first. Keen and waiting." from the row: what to do, to whom, and why now. */
function headline(row: TaskRow): string {
  const first = firstName(row.name);
  const what = whatToDo(row.verb, first);
  const why = row.warmth === "hot" ? " Keen and waiting." : row.lateDays >= 7 ? ` Waiting ${row.lateDays} days.` : "";
  return what + why;
}

/** The button's words: "Reply to Meilyn", "Approve Pamy's gift". */
function buttonLabel(row: TaskRow): string {
  const first = firstName(row.name);
  if (row.verb === "Reply") return `Reply to ${first}`;
  if (row.verb === "Send link") return `Send link to ${first}`;
  if (row.verb === "Approve") return `Approve ${first}'s gift`;
  return `${row.verb} ${first}`;
}

/**
 * Rachna's pick on Home: the one creator to act on first, said plainly, with
 * the one button. The choice is made on the server from today's task rows
 * (pickFor); this only shows it. Hidden with her tips.
 */
export function RachnaPick({ row }: { row: TaskRow | null }) {
  const rachna = useRachna();
  if (!row || !rachna?.tipsOn) return null;
  const facts = [row.followers !== null ? `${formatCount(row.followers)} followers` : null, row.lateDays > 0 ? daysLateText(row.lateDays) : "due today"].filter(Boolean).join(" · ");
  return (
    <section
      className="grid min-w-0 gap-3.5 rounded-[20px] border border-[color:var(--rachna-line)] bg-[radial-gradient(120%_90%_at_0%_0%,#ffe1ec_0%,#fff6f9_45%,#fff_100%)] p-5 shadow-[0_10px_28px_rgba(178,74,107,0.12)] dark:bg-[radial-gradient(120%_90%_at_0%_0%,var(--primary-faint)_0%,var(--surface)_60%)]"
      aria-labelledby="pick-title"
    >
      <div className="flex items-center gap-3">
        <RachnaPortrait pose="point" size={52} />
        <div className="min-w-0">
          <p id="pick-title" className="label text-primary">
            Rachna&apos;s pick
          </p>
          <p className="text-[13px] font-semibold text-muted-foreground">Do this one first</p>
        </div>
      </div>
      <p className="text-[19px] leading-snug font-extrabold tracking-[-0.01em] text-foreground">{headline(row)}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {row.warmth === "hot" ? (
          <span className="inline-flex h-6 items-center gap-1 rounded-full bg-danger-soft px-2.5 text-xs font-extrabold text-danger-text">
            <Flame className="size-3.5" strokeWidth={2.5} />
            Hot
          </span>
        ) : null}
        <CreatorName id={row.influencerId} name={row.name} className="text-[13px] font-bold text-foreground hover:text-primary" />
        <span className="truncate text-[13px] font-semibold text-muted-foreground" title={facts}>
          · {facts}
        </span>
      </div>
      {row.href ? (
        <Button asChild variant="action" className="w-full">
          <Link href={row.href}>
            {verbIcon(row.verb, "size-4")}
            {buttonLabel(row)}
          </Link>
        </Button>
      ) : (
        <MessageButton
          size="default"
          variant="action"
          className="w-full"
          label={buttonLabel(row)}
          icon={verbIcon(row.verb, "size-4")}
          target={{ campaignCreatorId: row.id, influencerName: row.name, status: row.status, profiles: row.profiles, email: row.email, amazonCreator: row.amazonCreator, blockedReason: row.blockedReason, purpose: row.purpose }}
        />
      )}
    </section>
  );
}
