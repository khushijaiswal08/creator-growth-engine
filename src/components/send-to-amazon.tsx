"use client";

import { PackageCheck, Truck } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { checkAmazonNow, previewForAmazon, sendToAmazon } from "@/actions/mcf";
import { Button } from "@/components/ui/button";
import type { McfPreview } from "@/lib/mcf";

const day = (value: string | Date | null) => (value ?new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null);

/** Amazon's order statuses in plain words. */
const STATUS_WORDS: Record<string, string> = {
  New: "received by Amazon",
  Received: "received by Amazon",
  Planning: "queued at Amazon",
  Processing: "being packed",
  Complete: "shipped",
  CompletePartialled: "partly shipped",
  Unfulfillable: "Amazon cannot ship it",
  Invalid: "Amazon refused it",
  Cancelled: "cancelled at Amazon",
};

type AmazonGift ={ id: string; reference: string; giftStatus: string; sentAt: Date | null; amazonStatus: string | null; error: string | null };

/**
 * One-click Amazon MCF in the gift drawer: first ask Amazon what it would
 * cost and when it would arrive, then place the order. After that it shows
 * what Amazon last said; tracking and delivery fill in by themselves.
 */
export function SendToAmazon({ gift }: { gift: AmazonGift }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [preview, setPreview] = useState<McfPreview | null>(null);
  const [alreadyThere, setAlreadyThere] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (gift.sentAt) {
    return (
      <div className="rounded-xl border border-[#d8f0e3] bg-success-soft/50 dark:border-[#1f4a33] px-4 py-3 text-sm">
        <p className="flex items-center gap-2 font-bold text-foreground">
          <PackageCheck className="size-4 text-success-text" /> Sent to Amazon as {gift.reference}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {day(gift.sentAt)}
          {gift.amazonStatus ? ` · ${STATUS_WORDS[gift.amazonStatus] ?? gift.amazonStatus}` : ""} · tracking and delivery update by themselves
        </p>
        {gift.error ? <p className="mt-1 text-xs font-semibold text-danger-text">{gift.error}</p> : null}
        {gift.giftStatus === "approved" || gift.giftStatus === "ordered" || gift.giftStatus === "shipped" ? (
          <button
            type="button"
            disabled={pending}
            className="link mt-1 text-xs font-semibold"
            onClick={() =>
              start(async () => {
                setError(null);
                try {
                  await checkAmazonNow(gift.id);
                } catch {
                  setError("Amazon could not be checked just now. Try again in a minute.");
                }
                router.refresh();
              })
            }
          >
            {pending ? "Checking..." : "Check Amazon now"}
          </button>
        ) : null}
        {error ? (
          <p role="alert" className="mt-1 text-xs font-semibold text-danger-text">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  function check() {
    setError(null);
    start(async () => {
      const result = await previewForAmazon(gift.id).catch(() => ({ ok: false as const, error: "Amazon could not be reached. Try again in a minute." }));
      if (result.ok) {
        setPreview(result.preview);
        setAlreadyThere(result.alreadyAtAmazon);
      } else setError(result.error);
    });
  }

  function place() {
    setError(null);
    start(async () => {
      const result = await sendToAmazon(gift.id).catch(() => ({ ok: false as const, error: "The answer was lost on the way. Do not send it again: press Check Amazon now in a minute, or wait for the hourly check." }));
      // The preview is spent either way: a new send starts from a fresh check.
      setPreview(null);
      setAlreadyThere(false);
      if (!result.ok) setError(result.error);
      router.refresh();
    });
  }

  const arrives = preview ? { from: day(preview.earliestArrival), to: day(preview.latestArrival) } : null;

  return (
    <div className="rounded-xl border px-4 py-3">
      <p className="label mb-1.5">Amazon</p>
      {preview ? (
        <div className="grid gap-2 text-sm">
          {alreadyThere ? (
            <p>Amazon already has this order ({gift.reference}), sent with the Amazon file. Link it here so tracking and delivery update by themselves; nothing is ordered again.</p>
          ) : preview.fulfillable ? (
            <p>
              Amazon can ship it
              {arrives?.from ? `, arriving ${arrives.from}${arrives.to && arrives.to !== arrives.from ? ` to ${arrives.to}` : ""}` : ""}
              {preview.feesUsd !== null ? `, for about $${preview.feesUsd.toFixed(2)} in fees` : ""}.
            </p>
          ) : (
            <p className="font-semibold text-danger-text">Amazon cannot ship this order{preview.reasons.length ? `: ${preview.reasons.join(", ").toLowerCase().replace(/_/g, " ")}` : ""}.</p>
          )}
          <div className="flex gap-2">
            {preview.fulfillable ? (
              <Button variant="action" disabled={pending} onClick={place}>
                <Truck className="size-4" /> {pending ? "Placing..." : alreadyThere ? "Link it" : "Place the order"}
              </Button>
            ) : null}
            <Button variant="outline" disabled={pending} onClick={() => setPreview(null)}>
              Not now
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="action" disabled={pending || gift.giftStatus !== "approved"} onClick={check}>
            <Truck className="size-4" /> {pending ? "Asking Amazon..." : "Send to Amazon"}
          </Button>
          <span className="text-xs text-muted-foreground">Checks the cost and delivery date first; nothing is ordered until you confirm.</span>
        </div>
      )}
      {error ? (
        <p role="alert" className="mt-2 text-xs font-semibold text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
