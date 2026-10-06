"use client";

import type { DataSource, EmailStatus, Platform, UsSignal } from "@prisma/client";
import { cn } from "cn";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { blacklistFromReview, decideReview, type ReviewDecision } from "@/actions/review";
import { Pill } from "@/components/status-pill";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { displayHandle, PLATFORM_LABELS, profileUrl } from "@/lib/profile-url";
import type { StatusTone } from "@/lib/status";

export type ReviewCard = {
  campaignCreatorId: string;
  influencerId: string;
  name: string;
  location: string | null;
  priorityReview: boolean;
  score: number | null;
  lowFit: boolean;
  usSignal: UsSignal | null;
  emailStatus: EmailStatus;
  reasons: string[];
  profiles: {
    id: string;
    platform: Platform;
    handle: string;
    followers: string;
    bio: string | null;
    source: DataSource;
    fetchNote: string | null;
  }[];
  latestPostUrl: string | null;
  latestPostDay: string;
  duplicates: { influencerId: string; name: string; platform: Platform; handle: string }[];
  /** What they did with earlier gifts, when there were any. */
  trackRecord: { text: string; tone: StatusTone } | null;
};

const US_LABELS: Record<UsSignal, string> = {
  confirmed: "US confirmed",
  likely: "US likely",
  unknown: "US unknown",
  unlikely: "US unlikely",
};

const SOURCE_LABELS: Record<DataSource, string> = {
  youtube: "YouTube discovery",
  meta_free: "Instagram discovery",
  vendor: "Data vendor",
  csv: "CSV import",
  manual: "Added by hand",
};

const KEYS: Record<string, ReviewDecision> = { a: "approve", r: "reject", l: "later" };

export function ReviewQueue({ cards }: { cards: ReviewCard[] }) {
  // Cards a decision has been made on in this visit; they drop out before the server list refreshes.
  const [done, setDone] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blacklisting, setBlacklisting] = useState<ReviewCard | null>(null);
  const [pending, startTransition] = useTransition();
  const cardRefs = useRef(new Map<string, HTMLElement>());

  const visible = cards.filter((card) => !done.has(card.campaignCreatorId));
  const active = visible.find((card) => card.campaignCreatorId === activeId) ?? visible[0] ?? null;

  const finish = useCallback(
    (card: ReviewCard, run: () => Promise<{ ok: true } | { ok: false; error: string }>) => {
      const index = visible.findIndex((item) => item.campaignCreatorId === card.campaignCreatorId);
      const next = visible[index + 1] ?? visible[index - 1] ?? null;
      startTransition(async () => {
        const result = await run();
        if (!result.ok) {
          setError(`${card.name}: ${result.error}`);
          return;
        }
        setError(null);
        setDone((previous) => new Set(previous).add(card.campaignCreatorId));
        setActiveId(next?.campaignCreatorId ?? null);
        if (next) cardRefs.current.get(next.campaignCreatorId)?.scrollIntoView({ block: "nearest" });
      });
    },
    [visible],
  );

  const decide = useCallback(
    (card: ReviewCard, decision: ReviewDecision) => finish(card, () => decideReview(card.campaignCreatorId, decision)),
    [finish],
  );

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return;
      // Typing in a field, or inside the blacklist dialog, must not trigger a decision.
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) {
        return;
      }
      const decision = KEYS[event.key.toLowerCase()];
      if (!decision || !active || pending || blacklisting) return;
      event.preventDefault();
      decide(active, decision);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, blacklisting, decide, pending]);

  if (visible.length === 0) {
    return (
      <p className="rounded-md border bg-surface px-4 py-8 text-center text-muted-foreground">
        Nothing to review with these filters.
      </p>
    );
  }

  return (
    <>
      {error ? (
        <p role="alert" className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
          {error}
        </p>
      ) : null}

      <ol className="grid gap-3">
        {visible.map((card) => {
          const isActive = card.campaignCreatorId === active?.campaignCreatorId;
          return (
            <li
              key={card.campaignCreatorId}
              ref={(element) => {
                if (element) cardRefs.current.set(card.campaignCreatorId, element);
                else cardRefs.current.delete(card.campaignCreatorId);
              }}
              onClick={() => setActiveId(card.campaignCreatorId)}
              aria-current={isActive ? "true" : undefined}
              className={cn(
                "grid gap-3 rounded-md border bg-surface p-4 md:grid-cols-[6.5rem_minmax(0,1fr)_auto]",
                isActive && "border-primary ring-2 ring-primary/25",
              )}
            >
              <div className="text-center">
                <div className="stat-number text-3xl">{card.score ?? "-"}</div>
                <div className="text-xs text-muted-foreground">{card.score === null ? "Not scored yet" : "AI fit score"}</div>
                <div className="mt-1.5 grid justify-items-center gap-1">
                  {card.priorityReview ? <Badge>Priority review</Badge> : null}
                  {card.lowFit ? <Badge variant="outline">Low fit</Badge> : null}
                </div>
              </div>

              <div className="grid min-w-0 content-start gap-2">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <Link href={`/influencers/${card.influencerId}`} className="font-heading text-lg font-medium text-foreground hover:text-primary-text hover:underline">
                    {card.name}
                  </Link>
                  <span className="text-muted-foreground">{card.location ?? "Location not known"}</span>
                </div>

                <ul className="grid gap-0.5">
                  {card.profiles.map((profile) => (
                    <li key={profile.id} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium">{PLATFORM_LABELS[profile.platform]}</span>
                      <a
                        href={profileUrl(profile.platform, profile.handle)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="link"
                      >
                        {displayHandle(profile.handle)}
                      </a>
                      <span className="text-muted-foreground tabular-nums">
                        {profile.followers ? `${profile.followers} followers` : "followers not known"}
                      </span>
                      <span className="text-xs text-muted-foreground">{SOURCE_LABELS[profile.source]}</span>
                      {profile.fetchNote ? <span className="text-xs text-muted-foreground">({profile.fetchNote})</span> : null}
                    </li>
                  ))}
                </ul>

                <div className="flex flex-wrap gap-1.5">
                  <Badge variant={card.emailStatus === "found" ? "secondary" : "outline"}>
                    {card.emailStatus === "found" ? "Email found" : "Email not found"}
                  </Badge>
                  <Badge variant="outline">{card.usSignal ? US_LABELS[card.usSignal] : "US signal not assessed"}</Badge>
                  {card.trackRecord ? <Pill tone={card.trackRecord.tone}>{card.trackRecord.text}</Pill> : null}
                  {card.latestPostUrl ? (
                    <a
                      href={card.latestPostUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="link text-xs underline"
                    >
                      Latest post{card.latestPostDay ? ` (${card.latestPostDay})` : ""}
                    </a>
                  ) : (
                    <span className="text-xs text-muted-foreground">No latest post on file</span>
                  )}
                </div>

                {card.duplicates.length > 0 ? (
                  <p className="rounded-md border border-primary/30 bg-primary-soft px-2.5 py-1.5 text-sm">
                    Possible duplicate of{" "}
                    {card.duplicates.map((duplicate, index) => (
                      <span key={`${duplicate.platform}:${duplicate.handle}`}>
                        {index > 0 ? ", " : ""}
                        <Link href={`/influencers/${duplicate.influencerId}`} className="link underline">
                          {duplicate.name}
                        </Link>{" "}
                        ({PLATFORM_LABELS[duplicate.platform]} {displayHandle(duplicate.handle)})
                      </span>
                    ))}
                    . Check before approving.
                  </p>
                ) : null}

                {card.reasons.length > 0 ? (
                  <ul className="list-disc pl-5 text-sm">
                    {card.reasons.map((reason, index) => (
                      <li key={index}>{reason}</li>
                    ))}
                  </ul>
                ) : card.profiles[0]?.bio ? (
                  <p className="line-clamp-3 text-sm text-muted-foreground">{card.profiles[0].bio}</p>
                ) : null}
              </div>

              <div className="flex flex-wrap content-start gap-1.5 md:w-36 md:flex-col">
                <Button type="button" size="sm" disabled={pending} onClick={() => decide(card, "approve")}>
                  Approve <kbd className="ml-auto text-xs opacity-70">A</kbd>
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => decide(card, "reject")}>
                  Reject <kbd className="ml-auto text-xs opacity-70">R</kbd>
                </Button>
                <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => decide(card, "later")}>
                  Review later <kbd className="ml-auto text-xs opacity-70">L</kbd>
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setBlacklisting(card)}>
                  Blacklist
                </Button>
              </div>
            </li>
          );
        })}
      </ol>

      <Dialog open={blacklisting !== null} onOpenChange={(open) => !open && setBlacklisting(null)}>
        {blacklisting ? (
          <BlacklistDialog
            key={blacklisting.campaignCreatorId}
            card={blacklisting}
            onCancel={() => setBlacklisting(null)}
            onConfirm={(reason) => {
              const card = blacklisting;
              setBlacklisting(null);
              finish(card, () => blacklistFromReview(card.campaignCreatorId, reason));
            }}
          />
        ) : null}
      </Dialog>
    </>
  );
}

function BlacklistDialog({
  card,
  onCancel,
  onConfirm,
}: {
  card: ReviewCard;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const valid = reason.trim().length >= 3;

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Blacklist {card.name}</DialogTitle>
        <DialogDescription>
          Their handles and email go on the do-not-contact list for every campaign. An admin can remove them later.
        </DialogDescription>
      </DialogHeader>
      <form
        className="grid gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) onConfirm(reason);
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="blacklist-reason">Reason</Label>
          <Input
            id="blacklist-reason"
            value={reason}
            maxLength={300}
            autoFocus
            placeholder="e.g. sells counterfeit goods"
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="action" disabled={!valid}>
            Blacklist
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
