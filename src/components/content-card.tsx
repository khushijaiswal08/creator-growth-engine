"use client";

import { cn } from "cn";
import { Check, Download, Film, MessageSquareWarning, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { archiveContent, reviewContent } from "@/actions/content";
import { CreatorName } from "@/components/creator-card";
import { Pill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CONTENT_STATUS_TONES, USAGE_TONES } from "@/lib/status";

export type ContentCardData = {
  id: string;
  kind: "video" | "photo" | "other";
  fileName: string;
  sizeLabel: string;
  status: "received" | "approved" | "changes_requested";
  statusLabel: string;
  usageLabel: string;
  usage: "organic" | "paid" | "none";
  viewUrl: string;
  downloadUrl: string;
  creator: { id: string; name: string };
  campaign: string;
  product: string | null;
  postUrl: string | null;
  receivedLabel: string;
  creatorNote: string | null;
  reviewNote: string | null;
  reviewedBy: string | null;
};

/** One file in the content library: the preview, what the creator allows, and the team's decision. */
export function ContentCard({ asset }: { asset: ContentCardData }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  function run(task: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError(null);
    start(async () => {
      const result = await task();
      if (!result.ok) setError(result.error);
      else {
        setAsking(false);
        setNote("");
        router.refresh();
      }
    });
  }

  return (
    <article className="card flex flex-col overflow-hidden">
      <div className="relative aspect-[4/5] bg-[#0f172a]">
        {!asset.viewUrl ? (
          <span className="flex size-full items-center justify-center px-6 text-center text-sm font-semibold text-white/70">Storage is not connected</span>
        ) : asset.kind === "photo" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={asset.viewUrl} alt={asset.fileName} loading="lazy" className="size-full object-contain" />
        ) : asset.kind === "video" ? (
          <video src={asset.viewUrl} controls preload="metadata" playsInline className="size-full object-contain" />
        ) : (
          <span className="flex size-full items-center justify-center text-white/70">
            <Film className="size-8" />
          </span>
        )}
        <span className="absolute top-2.5 left-2.5">
          <Pill tone={CONTENT_STATUS_TONES[asset.status]}>{asset.statusLabel}</Pill>
        </span>
      </div>

      <div className="grid flex-1 content-start gap-2 p-4">
        <div className="min-w-0">
          <CreatorName id={asset.creator.id} name={asset.creator.name} className="font-bold text-foreground hover:text-primary-text" />
          <p className="truncate text-xs font-medium text-muted-foreground">
            {asset.campaign}
            {asset.product ? ` · ${asset.product}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone={USAGE_TONES[asset.usage]}>{asset.usageLabel}</Pill>
          {asset.postUrl ? (
            <a href={asset.postUrl} target="_blank" rel="noopener noreferrer" className="link text-xs font-semibold">
              Post
            </a>
          ) : null}
        </div>
        <p className="truncate text-xs text-muted-foreground" title={asset.fileName}>
          {asset.fileName} · {asset.sizeLabel} · {asset.receivedLabel}
        </p>
        {asset.creatorNote ? <p className="rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs">&ldquo;{asset.creatorNote}&rdquo;</p> : null}
        {asset.reviewNote ? (
          <p className="rounded-lg bg-danger-soft px-2.5 py-1.5 text-xs text-danger-text">
            Asked{asset.reviewedBy ? ` by ${asset.reviewedBy}` : ""}: {asset.reviewNote}
          </p>
        ) : null}

        {asking ? (
          <div className="grid gap-2">
            <Textarea rows={2} autoFocus placeholder="What should change? (for your next message)" value={note} onChange={(event) => setNote(event.target.value)} maxLength={1000} />
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={pending} onClick={() => setAsking(false)}>
                Cancel
              </Button>
              <Button size="sm" disabled={pending || !note.trim()} onClick={() => run(() => reviewContent(asset.id, "changes", note))}>
                Save
              </Button>
            </div>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs font-semibold text-danger-text">
            {error}
          </p>
        ) : null}
      </div>

      <div className={cn("flex items-center gap-1.5 border-t px-3 py-2.5", asking && "hidden")}>
        {asset.status !== "approved" ? (
          <Button size="sm" variant="action" disabled={pending} onClick={() => run(() => reviewContent(asset.id, "approve"))}>
            <Check className="size-4" /> Approve
          </Button>
        ) : null}
        {asset.status !== "changes_requested" ? (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => setAsking(true)} title="Ask for changes">
            <MessageSquareWarning className="size-4" /> Changes
          </Button>
        ) : null}
        <span className="ml-auto flex items-center gap-0.5">
          <a href={asset.downloadUrl || undefined} title="Download the original" aria-label={`Download ${asset.fileName}`} className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-2 hover:text-foreground">
            <Download className="size-4" />
          </a>
          <button
            type="button"
            title="Remove from the library (the file is kept)"
            aria-label={`Remove ${asset.fileName} from the library`}
            disabled={pending}
            onClick={() => {
              if (window.confirm(`Remove "${asset.fileName}" from the library? The file itself is kept.`)) run(() => archiveContent(asset.id));
            }}
            className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-surface-2 hover:text-danger-text"
          >
            <Trash2 className="size-4" />
          </button>
        </span>
      </div>
    </article>
  );
}
