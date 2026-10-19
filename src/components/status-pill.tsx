import type { CampaignStatus, CreatorStatus } from "@prisma/client";
import { cn } from "cn";
import {
  CAMPAIGN_STATUS_LABELS,
  CAMPAIGN_STATUS_TONES,
  CREATOR_STATUS_LABELS,
  CREATOR_STATUS_TONES,
  TONE_CLASSES,
  type StatusTone,
} from "@/lib/status";

/** A small tinted chip in the tone's colour. The one place that decides what a tone looks like. */
export function Pill({ tone, className, children }: { tone: StatusTone; className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap", TONE_CLASSES[tone], className)}>
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
