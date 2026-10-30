"use client";

import { Check, Copy, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { archiveAttributionLink, saveAttributionLink } from "@/actions/amazon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type SavedLink = {
  id: string;
  url: string;
  adGroupName: string;
  landing: string;
  clicks: number;
  purchases: number;
  sales: number;
  conversion: number | null;
};

function CopyText({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground"
    >
      {copied ? <Check className="size-3.5 text-success-text" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/**
 * The creator's Amazon Attribution tag for this campaign: how to make it,
 * where to paste it, and what Amazon counted for it once a report is imported.
 */
export function AttributionLinkCard({ campaignCreatorId, campaignName, suggestedName, links }: { campaignCreatorId: string; campaignName: string; suggestedName: string; links: SavedLink[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(links.length === 0);
  const [url, setUrl] = useState("");
  const [adGroup, setAdGroup] = useState(suggestedName);
  const [error, setError] = useState<string | null>(null);

  function run(task: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) {
    setError(null);
    start(async () => {
      const result = await task();
      if (!result.ok) setError(result.error);
      else {
        after?.();
        router.refresh();
      }
    });
  }

  return (
    <section className="card p-5">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2>Amazon tracking link</h2>
        {!adding && links.length > 0 ? (
          <button type="button" className="link text-xs" onClick={() => setAdding(true)}>
            Add another
          </button>
        ) : null}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{campaignName}. Messages fill it in as {"{amazon_link}"}.</p>

      {links.length > 0 ? (
        <ul className="mb-3 grid gap-3">
          {links.map((link) => (
            <li key={link.id} className="rounded-xl border p-3">
              <div className="flex items-center gap-1">
                <p className="min-w-0 flex-1 truncate text-sm font-bold" title={link.adGroupName}>
                  {link.adGroupName}
                </p>
                <CopyText text={link.url} label="Copy the link" />
                <button
                  type="button"
                  title="Remove this link (its numbers are kept)"
                  aria-label={`Remove ${link.adGroupName}`}
                  disabled={pending}
                  onClick={() => {
                    if (window.confirm("Remove this tracking link? Its numbers stay in the reports.")) run(() => archiveAttributionLink(link.id));
                  }}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-danger-text"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
              <p className="text-xs text-muted-foreground">{link.landing}</p>
              <dl className="mt-2 grid grid-cols-4 gap-1 text-center">
                {(
                  [
                    ["Clicks", link.clicks.toLocaleString("en-US")],
                    ["Orders", link.purchases.toLocaleString("en-US")],
                    ["Sales", `$${Math.round(link.sales).toLocaleString("en-US")}`],
                    ["Conv.", link.conversion === null ? "–" : `${link.conversion}%`],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="rounded-lg bg-surface-2/70 px-1 py-1.5">
                    <dt className="text-[10.5px] font-bold text-muted-foreground uppercase">{label}</dt>
                    <dd className="text-sm font-extrabold tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      ) : null}

      {adding ? (
        <div className="grid gap-3">
          <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
            <li>In Amazon Ads open Amazon Attribution and add an ad group to the brand&apos;s creator campaign.</li>
            <li className="flex flex-wrap items-center gap-1">
              Name it <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-foreground">{suggestedName}</span>
              <CopyText text={suggestedName} label="Copy the ad group name" />
            </li>
            <li>Point it at the product page, copy its tag and paste it here.</li>
          </ol>
          <div className="grid gap-1.5">
            <Label htmlFor={`aa-url-${campaignCreatorId}`}>Tag from Amazon Attribution</Label>
            <Input id={`aa-url-${campaignCreatorId}`} placeholder="https://www.amazon.com/dp/...?maas=...&ref_=aa_maas&tag=maas" value={url} onChange={(event) => setUrl(event.target.value)} disabled={pending} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`aa-group-${campaignCreatorId}`}>Ad group name, as in Amazon</Label>
            <Input id={`aa-group-${campaignCreatorId}`} value={adGroup} onChange={(event) => setAdGroup(event.target.value)} disabled={pending} />
          </div>
          {error ? (
            <p role="alert" className="text-xs font-semibold text-danger-text">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button size="sm" disabled={pending || !url.trim() || !adGroup.trim()} onClick={() => run(() => saveAttributionLink(campaignCreatorId, url, adGroup), () => { setUrl(""); setAdding(false); })}>
              Save link
            </Button>
            {links.length > 0 ? (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => setAdding(false)}>
                Cancel
              </Button>
            ) : null}
          </div>
        </div>
      ) : error ? (
        <p role="alert" className="text-xs font-semibold text-danger-text">
          {error}
        </p>
      ) : null}
    </section>
  );
}
