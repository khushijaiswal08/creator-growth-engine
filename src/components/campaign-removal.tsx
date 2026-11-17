"use client";

import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteCampaign, setCampaignArchived } from "@/actions/campaigns";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Props = {
  campaignId: string;
  name: string;
  /** Creators in the campaign: none means it can be deleted; any means archive. */
  creators: number;
  discoveryRuns: number;
  archived: boolean;
};

/**
 * The bottom of a campaign's Settings tab: delete an empty campaign for good,
 * archive one that holds creators, or restore an archived one. Each asks first.
 */
export function CampaignRemoval({ campaignId, name, creators, discoveryRuns, archived }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const mode: "delete" | "archive" | "restore" = archived ? "restore" : creators === 0 ? "delete" : "archive";

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = mode === "delete" ? await deleteCampaign(campaignId) : await setCampaignArchived(campaignId, mode === "archive");
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      if (mode === "delete") router.push("/campaigns");
      else router.refresh();
    });
  }

  const copy = {
    delete: {
      title: "Delete this campaign",
      text: `"${name}" has no creators in it, so it can be deleted for good${discoveryRuns > 0 ? `, together with its ${discoveryRuns} discovery ${discoveryRuns === 1 ? "try" : "tries"}` : ""}. Use this for a test or a campaign made by mistake.`,
      button: "Delete campaign",
      confirmTitle: `Delete "${name}"?`,
      confirmText: `The campaign${discoveryRuns > 0 ? " and its discovery tries" : ""} will be removed for good. This cannot be undone. No creators, gifts or messages are affected, because it has none.`,
      confirmButton: "Delete for good",
    },
    archive: {
      title: "Archive this campaign",
      text: `"${name}" has ${creators.toLocaleString("en-US")} ${creators === 1 ? "creator" : "creators"}, so it cannot be deleted: that would wipe their history, gifts and messages. Archiving takes it off the Campaigns page and stops its timers, and keeps everything. You can restore it any time.`,
      button: "Archive campaign",
      confirmTitle: `Archive "${name}"?`,
      confirmText: "It moves to Archived on the Campaigns page and its follow-up timers stop. Every creator, gift, message and note is kept. You can restore it from here.",
      confirmButton: "Archive",
    },
    restore: {
      title: "This campaign is archived",
      text: "It is off the Campaigns page and its timers are stopped. Restoring brings it back as Paused, so nothing starts again until someone sets it going.",
      button: "Restore campaign",
      confirmTitle: `Restore "${name}"?`,
      confirmText: "It comes back to the Campaigns page as Paused.",
      confirmButton: "Restore",
    },
  }[mode];
  const Icon = mode === "delete" ? Trash2 : mode === "archive" ? Archive : ArchiveRestore;

  return (
    <section id="remove" className="card p-5">
      <h2>{copy.title}</h2>
      <p className="mt-2 max-w-3xl text-sm text-muted-foreground">{copy.text}</p>
      <Button type="button" variant={mode === "restore" ? "outline" : "destructive"} className="mt-4" onClick={() => setOpen(true)}>
        <Icon className="size-4" strokeWidth={2.2} />
        {copy.button}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{copy.confirmTitle}</DialogTitle>
            <DialogDescription>{copy.confirmText}</DialogDescription>
          </DialogHeader>
          {error ? (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant={mode === "restore" ? "action" : "destructive"} disabled={pending} onClick={confirm}>
              {pending ? "Working..." : copy.confirmButton}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
