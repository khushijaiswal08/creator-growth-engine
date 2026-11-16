"use client";

import { cn } from "cn";
import { CheckCircle2, Film, ImageIcon, UploadCloud, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { finishContentUpload, signContentUpload, startContentUpload } from "@/actions/content-upload";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const USAGE_OPTIONS = [
  { value: "paid", title: "Posts and paid ads", detail: "You may share it on your pages and use it in ads." },
  { value: "organic", title: "Posts only", detail: "You may share it on your own pages, but not in paid ads." },
  { value: "none", title: "Please don't repost", detail: "Keep it for reference only." },
] as const;

/** Files going up at once: enough to keep a connection busy without starving each one. */
const PARALLEL = 2;

const megabytes = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1e6).toFixed(1)} MB`);

type Progress = Record<number, { sent: number; failed?: boolean; done?: boolean }>;

/** Sends one file to its signed address, reporting progress. Resolves true when storage accepted it. */
function put(file: File, url: string, headers: Record<string, string>, onProgress: (sent: number) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
    request.upload.onprogress = (event) => onProgress(event.loaded);
    request.onload = () => resolve(request.status >= 200 && request.status < 300);
    request.onerror = () => resolve(false);
    request.send(file);
  });
}

/**
 * Pick files, say how they may be used, send. The bytes go straight from the
 * browser to storage, file by file with a progress bar; the portal only
 * hands out the addresses and checks what arrived.
 */
export function UploadForm({ token }: { token: string }) {
  const router = useRouter();
  const [files, setFiles] = useState<File[]>([]);
  const [usage, setUsage] = useState("");
  const [postUrl, setPostUrl] = useState("");
  const [postedOn, setPostedOn] = useState("");
  const [note, setNote] = useState("");
  const [progress, setProgress] = useState<Progress>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function add(list: FileList | null) {
    // While a batch is going up the list is fixed, so nothing added now could be lost when it clears. The 20 is MAX_FILES_PER_UPLOAD in src/lib/content-storage.ts, which this browser code cannot import.
    if (!list || busy) return;
    setDone(null);
    setFiles((current) => [...current, ...Array.from(list)].slice(0, 20));
  }

  /**
   * One file at a time per worker: ask for its address, send it, report it.
   * Each file is reported the moment it lands, so closing the page halfway
   * loses nothing that already arrived.
   */
  async function send() {
    setError(null);
    setDone(null);
    if (files.length === 0) return setError("Choose at least one video or photo.");
    if (!usage) return setError("Please choose how we may use your content.");
    setBusy(true);
    const batch = files;
    const arrived = new Set<number>();
    try {
      const started = await startContentUpload(token, { files: batch.map((file) => ({ name: file.name, type: file.type, size: file.size })), usage, postUrl, postedOn, note });
      if (!started.ok) return setError(started.error);

      let next = 0;
      const worker = async () => {
        while (next < batch.length) {
          const index = next++;
          const fail = () => setProgress((current) => ({ ...current, [index]: { sent: current[index]?.sent ?? 0, failed: true } }));
          const address = await signContentUpload(token, started.assetIds[index]);
          if (!address.ok) {
            fail();
            continue;
          }
          const ok = await put(batch[index], address.url, address.headers, (bytes) => setProgress((current) => ({ ...current, [index]: { sent: bytes } })));
          const reported = ok ? await finishContentUpload(token, [started.assetIds[index]]) : null;
          if (reported?.ok && reported.received === 1) {
            arrived.add(index);
            setProgress((current) => ({ ...current, [index]: { sent: batch[index].size, done: true } }));
          } else fail();
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL, batch.length) }, worker));
    } catch {
      // A dropped connection or a server hiccup: whatever arrived is already recorded.
    } finally {
      setBusy(false);
      setProgress({});
      // Keep only the files that did not make it, so "Send" tries just those again.
      setFiles(batch.filter((_, index) => !arrived.has(index)));
      // One refresh per batch updates "Already received" (the form keeps its state); never one per file.
      if (arrived.size > 0) router.refresh();
      if (arrived.size === batch.length) {
        setDone(`Thank you! ${arrived.size} ${arrived.size === 1 ? "file has" : "files have"} arrived. You can send more with this link any time.`);
      } else if (arrived.size > 0) {
        setError(`${arrived.size} of ${batch.length} files arrived. The others are still listed: press Send to try them again.`);
      } else {
        setError((current) => current ?? "Your files did not go through. Please check your connection and try again.");
      }
    }
  }

  return (
    <div className="grid gap-6">
      {/* The drop area is the picker's label, so it works with a tap on phones too. */}
      <label
        aria-disabled={busy}
        className={cn("flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-border bg-surface px-5 py-8 text-center transition-colors hover:border-primary hover:bg-primary-faint", busy && "pointer-events-none opacity-60")}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          add(event.dataTransfer.files);
        }}
      >
        <UploadCloud className="size-8 text-primary-text" strokeWidth={1.8} />
        <span className="font-bold text-foreground">Choose videos and photos</span>
        <span className="text-sm text-muted-foreground">or drop them here · up to 20 files, 2 GB each</span>
        <input type="file" multiple accept="video/*,image/*,.mov,.mp4,.heic" className="sr-only" disabled={busy} onChange={(event) => { add(event.target.files); event.target.value = ""; }} />
      </label>

      {files.length > 0 ? (
        <ul className="grid gap-2" aria-label="Files to send">
          {files.map((file, index) => {
            const state = progress[index];
            const share = state ? Math.min(100, Math.round((state.sent / Math.max(1, file.size)) * 100)) : 0;
            const Icon = file.type.startsWith("image/") ? ImageIcon : Film;
            return (
              <li key={`${file.name}-${index}`} className="rounded-xl border bg-surface px-3.5 py-2.5">
                <div className="flex items-center gap-3">
                  <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={2} />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold">{file.name}</span>
                  <span className="shrink-0 text-xs font-semibold text-muted-foreground tabular-nums">{megabytes(file.size)}</span>
                  {state?.done ? (
                    <CheckCircle2 className="size-4 shrink-0 text-success-text" strokeWidth={2.2} />
                  ) : busy ? null : (
                    <button type="button" aria-label={`Remove ${file.name}`} onClick={() => setFiles((current) => current.filter((_, at) => at !== index))} className="rounded-md p-0.5 text-muted-foreground hover:bg-surface-2 hover:text-foreground">
                      <X className="size-4" />
                    </button>
                  )}
                </div>
                {state ? (
                  <span aria-hidden className="mt-2 block h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <span className={cn("block h-full rounded-full transition-[width]", state.failed ? "bg-[#e11d48]" : "bg-primary")} style={{ width: `${share}%` }} />
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <fieldset className="grid gap-2">
        <legend className="mb-1.5 text-sm font-bold">How may we use it?</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {USAGE_OPTIONS.map((option) => (
            <label key={option.value} className="cursor-pointer">
              <input type="radio" name="usage" value={option.value} checked={usage === option.value} onChange={() => setUsage(option.value)} className="peer sr-only" disabled={busy} />
              <span className="flex h-full flex-col gap-1 rounded-xl border-2 border-border bg-surface p-3 peer-checked:border-primary peer-checked:bg-primary-faint peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring/35">
                <span className="text-sm font-bold text-foreground">{option.title}</span>
                <span className="text-xs font-medium text-muted-foreground">{option.detail}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-[1fr_11rem]">
        <div className="grid gap-1.5">
          <Label htmlFor="post-url">Link to your post (optional)</Label>
          <Input id="post-url" type="url" inputMode="url" placeholder="https://www.instagram.com/reel/..." value={postUrl} onChange={(event) => setPostUrl(event.target.value)} disabled={busy} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="posted-on">Posted on (optional)</Label>
          <Input id="posted-on" type="date" value={postedOn} onChange={(event) => setPostedOn(event.target.value)} disabled={busy} />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="upload-note">Anything we should know? (optional)</Label>
        <Textarea id="upload-note" rows={2} maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} disabled={busy} />
      </div>

      {error ? (
        <p role="alert" className="rounded-xl bg-danger-soft px-4 py-3 text-sm font-semibold text-danger-text">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="rounded-xl bg-success-soft px-4 py-3 text-sm font-semibold text-success-text">
          {done}
        </p>
      ) : null}

      <Button type="button" variant="action" size="lg" onClick={send} disabled={busy || files.length === 0}>
        {busy ? "Sending, please keep this page open..." : files.length > 0 ? `Send ${files.length} ${files.length === 1 ? "file" : "files"}` : "Send"}
      </Button>
    </div>
  );
}
