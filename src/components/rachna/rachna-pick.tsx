"use client";

import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { CreatorName } from "@/components/creator-card";
import { MessageButton } from "@/components/message-button";
import { RachnaPortrait, useRachna } from "@/components/rachna/rachna";
import type { TaskRow } from "@/components/task-list";
import { Button } from "@/components/ui/button";
import { formatCount } from "@/lib/format";
import { pickReason } from "@/lib/rachna";

/**
 * Rachna's pick on Home: the one creator to act on first, with why and the
 * one button. The choice is made on the server from today's task rows
 * (pickFor); this only shows it. Hidden with her tips.
 */
export function RachnaPick({ row }: { row: TaskRow | null }) {
  const rachna = useRachna();
  if (!row || !rachna?.tipsOn) return null;
  const why = [row.readSummary ?? pickReason(row), row.followers !== null ? `${formatCount(row.followers)} followers` : null, row.campaignName ?? null].filter(Boolean).join(" · ");
  return (
    <section className="rachna-home" aria-labelledby="pick-title">
      <div className="mb-2 flex items-center gap-2">
        <RachnaPortrait pose="point" size={36} />
        <div>
          <h2 id="pick-title" className="text-primary-text">
            Rachna&apos;s pick
          </h2>
          <p className="text-xs text-muted-foreground">The one to act on first</p>
        </div>
      </div>
      <div className="flex items-center gap-3 rounded-xl bg-surface/80 p-3">
        <Avatar name={row.name} className="size-10" />
        <div className="min-w-0 flex-1">
          <CreatorName id={row.influencerId} name={row.name} className="block truncate font-semibold hover:text-primary-text" />
          <p className="truncate text-xs text-muted-foreground" title={why}>
            {why}
          </p>
        </div>
        {row.href ? (
          <Button asChild size="sm" variant="action">
            <Link href={row.href}>{row.verb}</Link>
          </Button>
        ) : (
          <MessageButton
            size="sm"
            variant="action"
            label={row.verb}
            target={{ campaignCreatorId: row.id, influencerName: row.name, status: row.status, profiles: row.profiles, email: row.email, amazonCreator: row.amazonCreator, blockedReason: row.blockedReason, purpose: row.purpose }}
          />
        )}
      </div>
    </section>
  );
}
