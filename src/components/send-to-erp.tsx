"use client";

import { ExternalLink, Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { sendToErp } from "@/actions/erp";
import { Button } from "@/components/ui/button";

type ErpGift = { id: string; reference: string; giftStatus: string; sentAt: Date | null; url: string | null; error: string | null };

const day = (value: Date | string) => new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/**
 * "Create order in ERP" in the gift drawer: Creator Setu's server sends the approved gift to the company ERP
 * (address included, server to server), then the ERP order opens in a new tab for the team to recheck the
 * product and send it to Amazon from there. The tab is opened at the click, so the browser does not block it.
 */
export function SendToErp({ gift }: { gift: ErpGift }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (gift.sentAt && gift.url) {
    return (
      <div className="rounded-xl border bg-surface-2 px-4 py-3 text-sm">
        <p className="flex items-center gap-2 font-bold text-foreground">
          <Send className="size-4 text-primary-text" /> In the ERP as {gift.reference}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">Sent {day(gift.sentAt)} · the team checks the product and sends it to Amazon from the ERP</p>
        <a href={gift.url} target="_blank" rel="noopener noreferrer" className="link mt-1 inline-flex items-center gap-1 text-xs">
          Open in ERP <ExternalLink className="size-3" />
        </a>
      </div>
    );
  }
  if (gift.giftStatus !== "approved") return null;

  return (
    <div className="grid gap-1.5">
      <Button
        type="button"
        variant="action"
        className="w-full"
        disabled={pending}
        onClick={() => {
          setError(null);
          const tab = window.open("about:blank", "_blank");
          start(async () => {
            const result = await sendToErp(gift.id).catch(() => ({ ok: false as const, error: "Creator Setu could not send it. Try again." }));
            if (result.ok) {
              if (tab) {
                tab.opener = null;
                tab.location.href = result.url;
              } else {
                window.open(result.url, "_blank", "noopener");
              }
              router.refresh();
            } else {
              tab?.close();
              setError(result.error);
            }
          });
        }}
      >
        <Send className="size-4" />
        {pending ? "Sending to the ERP..." : "Create order in ERP"}
      </Button>
      <p className="text-xs text-muted-foreground">Sends the creator&apos;s details to the ERP and opens the order there, ready for the product check.</p>
      {error || gift.error ? <p className="text-xs font-semibold text-danger-text">{error ?? gift.error}</p> : null}
    </div>
  );
}
