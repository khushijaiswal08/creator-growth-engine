"use client";

import type { CreatorStatus } from "@prisma/client";
import { cn } from "cn";
import { useOptimistic, useState, useTransition } from "react";
import { updateCreatorStatus } from "@/actions/campaign-creators";
import { NativeSelect } from "@/components/native-select";
import { CREATOR_STATUS_LABELS, CREATOR_STATUS_TONES, CREATOR_STATUSES, NEXT_STATUS_SUGGESTIONS, TONE_TEXT } from "@/lib/status";

/**
 * The "Move to" menu. The likely next steps come first; every status is still
 * there below them. Looks like plain text with a small arrow, not a tinted box.
 */
export function StatusSelect({
  campaignCreatorId,
  status,
  label,
  className,
}: {
  campaignCreatorId: string;
  status: CreatorStatus;
  /** Accessible name, e.g. "Status for Maya Torres". */
  label: string;
  className?: string;
}) {
  const [shown, setShown] = useOptimistic(status);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onChange(event: React.ChangeEvent<HTMLSelectElement>) {
    const next = event.target.value as CreatorStatus;
    startTransition(async () => {
      setShown(next);
      const result = await updateCreatorStatus(campaignCreatorId, next);
      setError(result.ok ? null : result.error);
    });
  }

  const likely = NEXT_STATUS_SUGGESTIONS[shown];

  return (
    <div className={className}>
      <NativeSelect
        aria-label={label}
        value={shown}
        onChange={onChange}
        disabled={pending}
        className={cn("h-7 w-auto max-w-48 rounded-full border-border-strong bg-transparent px-2.5 text-xs font-medium", TONE_TEXT[CREATOR_STATUS_TONES[shown]])}
      >
        <option value={shown} className="bg-surface text-foreground">
          {CREATOR_STATUS_LABELS[shown]}
        </option>
        {likely.length > 0 ? (
          <optgroup label="Move to">
            {likely.map((value) => (
              <option key={value} value={value} className="bg-surface text-foreground">
                {CREATOR_STATUS_LABELS[value]}
              </option>
            ))}
          </optgroup>
        ) : null}
        <optgroup label="Any status">
          {CREATOR_STATUSES.filter((value) => value !== shown && !likely.includes(value)).map((value) => (
            <option key={value} value={value} className="bg-surface text-foreground">
              {CREATOR_STATUS_LABELS[value]}
            </option>
          ))}
        </optgroup>
      </NativeSelect>
      {error ? (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
