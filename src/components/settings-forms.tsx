"use client";

import { useActionState, useState } from "react";
import { activateScoringPrompt, saveBrandTargets, saveScoringPrompt } from "@/actions/settings";
import { FormError } from "@/components/form-error";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { FormState } from "@/lib/form";
import { WEIGHT_KEYS, WEIGHT_LABELS, type Weights } from "@/lib/scoring-prompts";

function FormMessage({ state }: { state: FormState }) {
  if (!state?.message) return null;
  return (
    <p role="status" className="text-sm text-success-text">
      {state.message}
    </p>
  );
}

export function TargetsForm({ brandId, daily, weekly, creatorConnectionsUrl }: { brandId: string; daily: number; weekly: number; creatorConnectionsUrl: string | null }) {
  const [state, action] = useActionState(saveBrandTargets, null);
  return (
    <form action={action} className="grid gap-3 pt-3">
      <input type="hidden" name="brandId" value={brandId} />
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor={`daily-${brandId}`}>Messages a day, per person</Label>
          <Input id={`daily-${brandId}`} name="daily" type="number" min={0} max={1000} step={1} defaultValue={daily} className="w-28" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`weekly-${brandId}`}>Messages a week, per person</Label>
          <Input id={`weekly-${brandId}`} name="weekly" type="number" min={0} max={1000} step={1} defaultValue={weekly} className="w-28" />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`cc-${brandId}`}>Creator Connections page in the Amazon Ads console</Label>
        <Input id={`cc-${brandId}`} name="creatorConnectionsUrl" type="url" placeholder="https://advertising.amazon.com/..." defaultValue={creatorConnectionsUrl ?? ""} className="max-w-xl" />
        <p className="text-xs text-muted-foreground">Where Message goes for Creator Connections creators. Copy it from this brand&apos;s Ads console; empty opens the console home.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton pendingLabel="Saving...">Save</SubmitButton>
        <FormError state={state} />
        <FormMessage state={state} />
      </div>
    </form>
  );
}

export type PromptVersionRow = { version: number; active: boolean; note: string | null; createdAt: string; createdBy: string };

export function ScoringPromptForm({
  brandId,
  version,
  guidance,
  weights,
  versions,
}: {
  brandId: string;
  version: number;
  guidance: string;
  weights: Weights;
  versions: PromptVersionRow[];
}) {
  const [state, action] = useActionState(saveScoringPrompt, null);
  const [current, setCurrent] = useState<Weights>(weights);
  const [activateState, setActivateState] = useState<FormState>(null);
  const total = WEIGHT_KEYS.reduce((sum, key) => sum + (Number.isFinite(current[key]) ? current[key] : 0), 0);

  return (
    <div className="grid gap-4 pt-3">
      <form action={action} className="grid gap-4">
        <input type="hidden" name="brandId" value={brandId} />
        <div className="grid gap-1.5">
          <Label htmlFor={`guidance-${brandId}`}>Guidance to the model (version {version} is active)</Label>
          <Textarea id={`guidance-${brandId}`} name="guidance" rows={6} defaultValue={guidance} required />
          <p className="text-xs text-muted-foreground">
            The weighted parts and the fixed rules (missing information, negative keywords, the US signal, the reasons format, never approving) are added after this text automatically.
          </p>
        </div>
        <fieldset className="grid gap-2">
          <legend className="text-sm font-medium">
            Weights <span className={total === 100 ? "text-muted-foreground" : "text-danger-text"}>(total {total}, must be 100)</span>
          </legend>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {WEIGHT_KEYS.map((key) => (
              <label key={key} className="grid gap-1 text-sm">
                <span>{WEIGHT_LABELS[key]}</span>
                <Input name={key} type="number" min={0} max={100} step={1} value={current[key]} onChange={(event) => setCurrent({ ...current, [key]: Number(event.target.value) })} className="w-24" />
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-1.5 sm:max-w-md">
          <Label htmlFor={`note-${brandId}`}>What changed and why (optional)</Label>
          <Input id={`note-${brandId}`} name="note" maxLength={300} placeholder="e.g. weight US audience higher after calibration" />
        </div>
        <FormError state={state} />
        <div className="flex items-center gap-3">
          <SubmitButton variant="action" pendingLabel="Saving...">
            Save as a new version
          </SubmitButton>
          <FormMessage state={state} />
        </div>
      </form>

      {versions.length > 0 ? (
        <div className="grid gap-1 border-t pt-3 text-sm">
          <p className="eyebrow">Versions</p>
          {versions.map((row) => (
            <div key={row.version} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium">Version {row.version}</span>
              <span className="text-muted-foreground">
                {row.createdAt} by {row.createdBy}
                {row.note ? `: ${row.note}` : ""}
              </span>
              {row.active ? (
                <span className="text-xs text-success-text">Active</span>
              ) : (
                <Button type="button" size="xs" variant="outline" onClick={async () => setActivateState(await activateScoringPrompt(brandId, row.version))}>
                  Make active
                </Button>
              )}
            </div>
          ))}
          <FormError state={activateState} />
          <FormMessage state={activateState} />
        </div>
      ) : null}
    </div>
  );
}
