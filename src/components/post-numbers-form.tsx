"use client";

import { useActionState } from "react";
import { logPostNumbers } from "@/actions/creator-card";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { formatCount, formatDay } from "@/lib/format";

export type LatestNumbers = { views: number | null; likes: number | null; comments: number | null; shares: number | null; clicks: number | null; salesUsd: number | null; capturedAt: Date } | null;

const FIELDS = [
  ["views", "Views"],
  ["likes", "Likes"],
  ["comments", "Comments"],
  ["shares", "Shares"],
  ["clicks", "Clicks to Amazon"],
] as const;

/**
 * The numbers behind one post, typed in from the creator's screenshot or
 * Amazon Attribution: views, likes, comments, shares, clicks and sales. Each
 * save is a fresh reading; the creator card and Reports use the latest.
 */
export function PostNumbersForm({ postId, latest }: { postId: string; latest: LatestNumbers }) {
  const [state, action] = useActionState(logPostNumbers, null);
  const summary = latest
    ? [
        latest.views !== null ? `${formatCount(latest.views)} views` : null,
        latest.likes !== null ? `${formatCount(latest.likes)} likes` : null,
        latest.comments !== null ? `${formatCount(latest.comments)} comments` : null,
        latest.shares !== null ? `${formatCount(latest.shares)} shares` : null,
        latest.clicks !== null ? `${formatCount(latest.clicks)} clicks` : null,
        latest.salesUsd !== null ? `$${latest.salesUsd.toLocaleString("en-US", { minimumFractionDigits: latest.salesUsd % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })} sales` : null,
      ].filter(Boolean)
    : [];

  return (
    <details className="disclosure mt-1">
      <summary>{summary.length > 0 ? `${summary.join(", ")} · logged ${formatDay(latest!.capturedAt)} · update` : "Log the numbers"}</summary>
      <form action={action} className="mt-2 grid gap-2">
        <input type="hidden" name="postId" value={postId} />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
          {FIELDS.map(([name, label]) => (
            <label key={name} className="grid gap-1 text-xs font-medium text-muted-foreground">
              {label}
              <Input name={name} inputMode="numeric" placeholder={latest?.[name] !== null && latest?.[name] !== undefined ? String(latest[name]) : "0"} className="h-8 text-sm text-foreground" />
            </label>
          ))}
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            Sales (US$)
            <Input name="salesUsd" inputMode="decimal" placeholder={latest?.salesUsd !== null && latest?.salesUsd !== undefined ? String(latest.salesUsd) : "0"} className="h-8 text-sm text-foreground" />
          </label>
        </div>
        <FormError state={state} />
        <div className="flex items-center gap-3">
          <SubmitButton size="sm" pendingLabel="Saving...">
            Save numbers
          </SubmitButton>
          {state?.message ? (
            <span role="status" className="text-xs text-success-text">
              {state.message}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">Leave a box empty to keep the last value out of this reading.</span>
          )}
        </div>
      </form>
    </details>
  );
}
