import type { CampaignStatus, CreatorStatus } from "@prisma/client";
import { cn } from "cn";
import {
  CAMPAIGN_STATUS_LABELS,
  CAMPAIGN_STATUS_TONES,
  CREATOR_STATUS_LABELS,
  CREATOR_STATUS_TONES,
  TONE_DOT,
  TONE_TEXT,
  type StatusTone,
} from "@/lib/status";

/** A small dot in the tone's colour and plain text. The one place that decides what a tone looks like. */
export function Pill({ tone, className, children }: { tone: StatusTone; className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap", TONE_TEXT[tone], className)}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE_DOT[tone])} />
      {children}
    </span>
  );
}

export function CreatorStatusPill({ status }: { status: CreatorStatus }) {
  return <Pill tone={CREATOR_STATUS_TONES[status]}>{CREATOR_STATUS_LABELS[status]}</Pill>;
}

export function CampaignStatusPill({ status }: { status: CampaignStatus }) {
  return <Pill tone={CAMPAIGN_STATUS_TONES[status]}>{CAMPAIGN_STATUS_LABELS[status]}</Pill>;
}

/** Outlined filter chip; add aria-current to the active one. */
export const pillClass = "chip";
