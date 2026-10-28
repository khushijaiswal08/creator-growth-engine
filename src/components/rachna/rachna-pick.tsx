"use client";

import { Flame } from "lucide-react";
import Link from "next/link";
import { CreatorName } from "@/components/creator-card";
import { MessageButton } from "@/components/message-button";
import { RachnaPortrait, useRachna } from "@/components/rachna/rachna";
import { verbIcon, type TaskRow } from "@/components/task-list";
import { Button } from "@/components/ui/button";
import { formatCount } from "@/lib/format";
import { firstName } from "@/lib/template";

/** "Answer Meilyn first. Keen and waiting." from the row: what to do, to whom, and why now. */
function headline(row: TaskRow): string {
  const first = firstName(row.name);
  const what =
    row.verb === "Reply"
      ? `Answer ${first} first.`
      : row.verb === "Send link"
        ? `Send ${first} the selection link.`
        : row.verb === "Approve"
          ? `Approve ${first}'s gift.`
          : row.verb === "Review"
            ? `Review ${first} first.`
            : row.verb === "Message"
              ? `Message ${first} first.`
              : `Check on ${first} first.`;
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
  const facts = [row.followers !== null ? `${formatCount(row.followers)} followers` : null, row.lateDays > 0 ? `${row.lateDays} ${row.lateDays === 1 ? "day" : "days"} late` : "due today"].filter(Boolean).join(" · ");
  return (
    <section
      className="grid min-w-0 gap-3.5 rounded-[20px] border border-[#f3cdd9] p-5 shadow-[0_10px_28px_rgba(178,74,107,0.12)]"
      style={{ background: "radial-gradient(120% 90% at 0% 0%, #ffe1ec 0%, #fff6f9 45%, #fff 100%)" }}
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
