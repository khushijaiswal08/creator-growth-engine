"use client";

import type { Platform } from "@prisma/client";
import { cn } from "cn";
import { RefreshCw } from "lucide-react";
import { useState, useTransition } from "react";
import { refreshPublicNumbers, saveCreatorInsight, type InsightInput } from "@/actions/creator-insights";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ActivitySummary, PeriodTotals, SuppliedInsight } from "@/lib/creator-insights";
import type { FormState } from "@/lib/form";
import { formatCount, formatDay, formatShortDay } from "@/lib/format";
import { displayHandle, PLATFORM_LABELS } from "@/lib/profile-url";

/** One profile's insights as the Review queue hands them to the card. */
export type CardInsights = { profileId: string; platform: Platform; handle: string; activity: ActivitySummary | null; supplied: SuppliedInsight | null };

const NONE = "–";
const whole = (value: number | null) => (value === null ? NONE : value.toLocaleString("en-US"));

/** A short line for the card itself: the 30-day activity of the first profile that has any, and the creator's own reach when sent. */
export function InsightsLine({ insights }: { insights: CardInsights[] }) {
  const withActivity = insights.find((item) => item.activity);
  const supplied = insights.find((item) => item.supplied?.reach30d != null)?.supplied ?? null;
  const parts: string[] = [];
  if (withActivity?.activity) {
    const { days30 } = withActivity.activity;
    parts.push(`Last 30 days: ${days30.posts} ${days30.posts === 1 ? "post" : "posts"}`);
    if (days30.likes !== null) parts.push(`${formatCount(days30.likes)} likes`);
    if (days30.comments !== null) parts.push(`${formatCount(days30.comments)} comments`);
    if (days30.views !== null) parts.push(`${formatCount(days30.views)} views`);
  }
  if (supplied?.reach30d != null) parts.push(`reached ${formatCount(supplied.reach30d)} (30 days, from the creator)`);
  if (parts.length === 0) return <span className="text-xs text-muted-foreground">No public numbers on file yet</span>;
  return <span className="text-xs text-muted-foreground tabular-nums">{parts.join(" · ")}</span>;
}

/** The Insights button on a review card, and the pop-up it opens. */
export function InsightsButton({ name, insights }: { name: string; insights: CardInsights[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Insights
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] gap-0 overflow-y-auto sm:max-w-[760px]" onClick={(event) => event.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>Insights: {name}</DialogTitle>
          <DialogDescription>
            Public numbers are what each platform shows anyone. Reach and profile views are private to the creator, so they appear here only when the creator sent them.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 pt-3">
          {insights.length === 0 ? <p className="text-sm text-muted-foreground">This creator has no profile to read.</p> : null}
          {insights.map((item) => (
            <ProfileSection key={item.profileId} item={item} />
          ))}
        </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ProfileSection({ item }: { item: CardInsights }) {
  const [refreshing, startRefresh] = useTransition();
  const [refreshed, setRefreshed] = useState<FormState>(null);
  const canRefresh = item.platform === "instagram" || item.platform === "youtube";

  return (
    <section className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-base font-extrabold">
          {PLATFORM_LABELS[item.platform]} {displayHandle(item.handle)}
        </h3>
        {canRefresh ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={refreshing}
            onClick={() => startRefresh(async () => setRefreshed(await refreshPublicNumbers(item.profileId)))}
          >
            <RefreshCw className={cn("size-[14px]", refreshing && "animate-spin")} strokeWidth={2.4} />
            {refreshing ? "Reading..." : "Refresh public numbers"}
          </Button>
        ) : null}
      </div>
      {refreshed?.error ? <FormError state={refreshed} /> : null}
      {refreshed?.message ? (
        <p role="status" className="text-sm text-muted-foreground">
          {refreshed.message}
        </p>
      ) : null}

      <Activity item={item} />
      <Supplied item={item} />
    </section>
  );
}

function Activity({ item }: { item: CardInsights }) {
  const { activity } = item;
  if (!activity) {
    return (
      <p className="rounded-xl border border-dashed px-4 py-4 text-sm text-muted-foreground">
        {item.platform === "instagram"
          ? "No public posts on file. Instagram shares public posts only for professional (business or creator) accounts, and only once the portal is connected to Meta."
          : item.platform === "youtube"
            ? "No public videos on file yet. They are read when the creator is discovered, or with Refresh public numbers."
            : `${PLATFORM_LABELS[item.platform]} public numbers cannot be read yet. Use the creator's own numbers below.`}
      </p>
    );
  }
  return (
    <div className="grid gap-3">
      <h4 className="label">Public activity</h4>
      <Grid
        head={["Period", "Posts", "Likes", "Comments", "Views", "Avg likes", "Avg comments"]}
        rows={[
          ["Last 7 days", ...cells(activity.days7)],
          ["Last 30 days", ...cells(activity.days30)],
        ]}
      />
      <Grid
        head={["Week by week", "Posts", "Likes", "Comments", "Views"]}
        rows={activity.weeks.map((week, index) => [`${index === 0 ? "This week" : `${index} ${index === 1 ? "week" : "weeks"} ago`}, ${formatShortDay(week.from)} to ${formatShortDay(week.to)}`, ...cells(week).slice(0, 4)])}
      />
      <p className="text-[12.5px] font-medium text-muted-foreground">
        Counted from {activity.postsHeld} public {activity.postsHeld === 1 ? "post" : "posts"}, read on {formatDay(activity.asOf)}. Likes, comments and views are the totals today on posts from that period, not gains within it.
        {item.platform === "youtube" ? " Views are each video's lifetime views." : " Views are reel views; photos have none."}
        {activity.mayBeIncomplete ? ` The newest posts read were all inside the last 30 days, so the creator may have posted more than are counted here.` : ""}
      </p>
    </div>
  );
}

const cells = (totals: PeriodTotals) => [String(totals.posts), whole(totals.likes), whole(totals.comments), whole(totals.views), whole(totals.avgLikes), whole(totals.avgComments)];

function Supplied({ item }: { item: CardInsights }) {
  const { supplied } = item;
  return (
    <div className="grid gap-3">
      <h4 className="label">Sent by the creator</h4>
      {supplied ? (
        <>
          <Grid
            head={["Measure", "Figure"]}
            rows={[
              ["Accounts reached, last 7 days", whole(supplied.reach7d)],
              ["Accounts reached, last 30 days", whole(supplied.reach30d)],
              ["Profile views, last 30 days", whole(supplied.profileViews30d)],
              ["Audience in the US", supplied.usAudiencePct === null ? NONE : `${supplied.usAudiencePct}%`],
            ]}
          />
          <p className="text-[12.5px] font-medium text-muted-foreground">
            Figures for {formatDay(supplied.asOf)}
            {supplied.evidence ? `, from ${supplied.evidence}` : ""}. Typed in by {supplied.addedBy}.{supplied.note ? ` ${supplied.note}` : ""}
          </p>
        </>
      ) : (
        <p className="rounded-xl border border-dashed px-4 py-4 text-sm text-muted-foreground">
          Nothing from the creator yet. Ask for a screenshot of their own Insights (reach, profile views, audience) or their media kit, then type the numbers in below.
        </p>
      )}
      <SuppliedForm profileId={item.profileId} hasEarlier={supplied !== null} />
    </div>
  );
}

function SuppliedForm({ profileId, hasEarlier }: { profileId: string; hasEarlier: boolean }) {
  const [state, setState] = useState<FormState>(null);
  const [pending, startSave] = useTransition();
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  // Sent as typed, not through a reset-on-return form, so a mistake does not wipe what was entered.
  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const text = (name: keyof InsightInput) => String(data.get(name) ?? "");
    const input: InsightInput = { reach7d: text("reach7d"), reach30d: text("reach30d"), profileViews30d: text("profileViews30d"), usAudiencePct: text("usAudiencePct"), evidence: text("evidence"), note: text("note"), asOf: text("asOf") };
    startSave(async () => setState(await saveCreatorInsight(profileId, input)));
  }
  const id = (name: string) => `${profileId}-${name}`;
  return (
    <form onSubmit={onSubmit} className="grid gap-3 rounded-xl border bg-surface-2/60 p-3.5">
      <p className="text-sm font-semibold">{hasEarlier ? "Add newer numbers from the creator" : "Add the creator's numbers"}</p>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="grid gap-1.5">
          <Label htmlFor={id("reach7d")}>Reached, 7 days</Label>
          <Input id={id("reach7d")} name="reach7d" inputMode="numeric" placeholder="e.g. 3200" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={id("reach30d")}>Reached, 30 days</Label>
          <Input id={id("reach30d")} name="reach30d" inputMode="numeric" placeholder="e.g. 12400" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={id("profileViews30d")}>Profile views, 30 days</Label>
          <Input id={id("profileViews30d")} name="profileViews30d" inputMode="numeric" placeholder="e.g. 850" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={id("usAudiencePct")}>US audience, %</Label>
          <Input id={id("usAudiencePct")} name="usAudiencePct" inputMode="numeric" placeholder="e.g. 84" />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr_1fr]">
        <div className="grid gap-1.5">
          <Label htmlFor={id("asOf")}>Figures are for</Label>
          <Input id={id("asOf")} name="asOf" type="date" required max={today} defaultValue={today} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={id("evidence")}>Where from</Label>
          <Input id={id("evidence")} name="evidence" maxLength={120} placeholder="e.g. Instagram Insights screenshot" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={id("note")}>Note</Label>
          <Input id={id("note")} name="note" maxLength={500} placeholder="optional" />
        </div>
      </div>
      <FormError state={state} />
      <div className="flex items-center justify-end gap-3">
        {state?.message ? (
          <p role="status" className="text-sm text-muted-foreground">
            {state.message}
          </p>
        ) : null}
        <SubmitButton pending={pending} pendingLabel="Saving..." size="sm">
          Save numbers
        </SubmitButton>
      </div>
    </form>
  );
}

/** Plain rows and columns, first column left, numbers right. */
function Grid({ head, rows }: { head: string[]; rows: string[][] }) {
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="bg-[#f8f9fb] dark:bg-surface-2">
            {head.map((label, column) => (
              <th key={label} scope="col" className={cn("border-b border-l px-2.5 py-2 text-[11px] font-bold tracking-[0.05em] whitespace-nowrap text-muted-foreground uppercase first:border-l-0", column === 0 ? "text-left" : "text-right")}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b last:border-b-0 even:bg-[#fcfcfd] dark:even:bg-surface-2/40">
              {row.map((cell, column) => (
                <td key={column} className={cn("border-l px-2.5 py-2 whitespace-nowrap first:border-l-0", column === 0 ? "text-left font-semibold text-foreground" : "text-right tabular-nums", cell === NONE && "text-faint")}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
