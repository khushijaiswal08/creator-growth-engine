"use client";

import { useState, useTransition } from "react";
import { recordCalibrationVerdict } from "@/actions/calibration";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export type CalibrationCard = {
  assessmentId: string;
  influencerId: string;
  name: string;
  handle: string | null;
  profileUrl: string | null;
  followers: string;
  bio: string | null;
  captions: string[];
  score: number;
  reasons: string[];
  promptVersion: string;
  verdict: boolean | null;
  note: string | null;
};

/** The model's score and reasons beside the reviewer's own yes or no. */
export function CalibrationCards({ cards }: { cards: CalibrationCard[] }) {
  const [state, setState] = useState<Record<string, { verdict: boolean | null; note: string; saved: boolean; error: string | null }>>(
    Object.fromEntries(cards.map((card) => [card.assessmentId, { verdict: card.verdict, note: card.note ?? "", saved: card.verdict !== null, error: null }])),
  );
  const [pending, startTransition] = useTransition();

  function save(card: CalibrationCard, verdict: boolean) {
    const current = state[card.assessmentId];
    setState((all) => ({ ...all, [card.assessmentId]: { ...current, verdict, saved: false, error: null } }));
    startTransition(async () => {
      const result = await recordCalibrationVerdict(card.assessmentId, verdict, current.note);
      setState((all) => ({ ...all, [card.assessmentId]: { ...all[card.assessmentId], verdict, saved: result.ok, error: result.ok ? null : result.error } }));
    });
  }

  return (
    <ol className="grid gap-4 lg:grid-cols-2">
      {cards.map((card) => {
        const own = state[card.assessmentId];
        return (
          <li key={card.assessmentId} className="card grid gap-3 p-4 md:grid-cols-[5rem_minmax(0,1fr)]">
            <div className="text-center">
              <div className="stat-number text-3xl">{card.score}</div>
              <div className="text-xs text-muted-foreground">AI score</div>
              <div className="mt-1 text-[11px] text-muted-foreground">{card.promptVersion}</div>
            </div>
            <div className="grid min-w-0 gap-2">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <a href={`/influencers/${card.influencerId}`} className="font-heading text-lg font-medium">
                  {card.name}
                </a>
                {card.profileUrl && card.handle ? (
                  <a href={card.profileUrl} target="_blank" rel="noopener noreferrer" className="link text-sm">
                    {card.handle}
                  </a>
                ) : null}
                <span className="text-xs text-muted-foreground">{card.followers ? `${card.followers} followers` : "followers not known"}</span>
              </div>
              {card.bio ? <p className="line-clamp-2 text-sm text-muted-foreground">{card.bio}</p> : null}
              {card.captions.length > 0 ? (
                <ul className="grid gap-0.5 text-xs text-muted-foreground">
                  {card.captions.slice(0, 2).map((caption, index) => (
                    <li key={index} className="line-clamp-1">
                      “{caption}”
                    </li>
                  ))}
                </ul>
              ) : null}
              <ul className="grid gap-0.5 text-sm">
                {card.reasons.map((reason, index) => (
                  <li key={index}>{reason}</li>
                ))}
              </ul>
              <div className="mt-1 grid gap-2 border-t pt-3">
                <p className="text-xs text-muted-foreground">Would you approve this creator for gifting?</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" variant={own.verdict === true ? "action" : "outline"} disabled={pending} onClick={() => save(card, true)}>
                    Yes
                  </Button>
                  <Button type="button" size="sm" variant={own.verdict === false ? "action" : "outline"} disabled={pending} onClick={() => save(card, false)}>
                    No
                  </Button>
                  {own.saved ? <span className="text-xs text-success-text">Saved</span> : null}
                  {own.error ? <span className="text-xs text-danger-text">{own.error}</span> : null}
                </div>
                <Textarea
                  rows={2}
                  placeholder="Why? One line helps tune the prompt."
                  value={own.note}
                  maxLength={500}
                  onChange={(event) => setState((all) => ({ ...all, [card.assessmentId]: { ...all[card.assessmentId], note: event.target.value, saved: false } }))}
                  onBlur={() => {
                    if (own.verdict !== null) save(card, own.verdict);
                  }}
                />
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
