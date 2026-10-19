"use client";

import { MessageSquare, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { findCreatorsToMessage, type CreatorToMessage } from "@/actions/find-creators";
import { Avatar } from "@/components/avatar";
import { useOpenComposer } from "@/components/message-button";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** "Check a profile": paste a link, see the creator before messaging. */
export function CheckProfileButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        Check a profile
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Check a profile</DialogTitle>
            <DialogDescription>Paste an Instagram, TikTok or YouTube link. If the creator is already in the portal you land on their page; otherwise you can add them.</DialogDescription>
          </DialogHeader>
          <form method="get" action="/influencers/new" className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="check-url">Profile link</Label>
              <Input id="check-url" name="url" type="url" inputMode="url" placeholder="https://www.instagram.com/handle" required autoFocus />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" variant="action">
                Check
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** "New message": find a creator by name or handle, then open the usual composer for them. */
export function NewMessageButton() {
  const openComposer = useOpenComposer();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CreatorToMessage[]>([]);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    const text = q.trim();
    if (text.length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      startTransition(async () => {
        setResults(await findCreatorsToMessage(text));
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [q, open]);

  function choose(creator: CreatorToMessage) {
    setOpen(false);
    openComposer?.({
      campaignCreatorId: creator.campaignCreatorId,
      influencerName: creator.influencerName,
      status: creator.status,
      profiles: creator.profiles,
      blockedReason: creator.blockedReason,
      purpose: creator.purpose,
    });
  }

  return (
    <>
      <Button type="button" variant="action" onClick={() => setOpen(true)}>
        <MessageSquare className="size-4" strokeWidth={2} />
        New message
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Who do you want to message?</DialogTitle>
            <DialogDescription>Creators in your open campaigns. The composer opens on the template that fits where they are.</DialogDescription>
          </DialogHeader>
          <label className="relative block">
            <span className="sr-only">Search creators</span>
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" strokeWidth={2} />
            <Input value={q} onChange={(event) => setQ(event.target.value)} placeholder="Name or handle" className="pl-9" autoFocus />
          </label>
          <ul className="grid max-h-80 gap-0.5 overflow-y-auto">
            {q.trim().length < 2 ? (
              <li className="px-2 py-6 text-center text-sm text-muted-foreground">Type at least two letters.</li>
            ) : results.length === 0 ? (
              <li className="px-2 py-6 text-center text-sm text-muted-foreground">
                {pending ? "Searching…" : "Nobody matches in an open campaign."}{" "}
                {!pending ? (
                  <Link href="/influencers/new" className="link">
                    Add a creator
                  </Link>
                ) : null}
              </li>
            ) : (
              results.map((creator) => (
                <li key={creator.campaignCreatorId}>
                  <button
                    type="button"
                    disabled={creator.blockedReason !== null || creator.profiles.length === 0}
                    title={creator.blockedReason ?? (creator.profiles.length === 0 ? "No profile to message" : undefined)}
                    onClick={() => choose(creator)}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-surface-2 disabled:opacity-50"
                  >
                    <Avatar name={creator.influencerName} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{creator.influencerName}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {creator.handle ?? "No profile"} · {creator.campaignName} · {creator.statusLabel}
                      </span>
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
