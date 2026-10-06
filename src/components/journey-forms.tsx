"use client";

import { startTransition, useActionState, useState } from "react";
import { importTracking, updateGift } from "@/actions/gifts";
import { addPost, runAutomationsNow, saveCampaignAutomation, setOfferedForList, uploadProducts } from "@/actions/journey";
import { logReply } from "@/actions/replies";
import { FormError } from "@/components/form-error";
import { NativeSelect } from "@/components/native-select";
import { SubmitButton } from "@/components/submit-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { LISTING_SHEET, readListingRows } from "@/lib/amazon-listing";
import { BRANDS } from "@/lib/brands";
import type { FormState } from "@/lib/form";
import { REPLY_CLASS_LABELS, REPLY_CLASSES, REPLY_OUTCOMES, type ReplyClass } from "@/lib/replies";

function FormMessage({ state }: { state: FormState }) {
  if (!state?.message) return null;
  return (
    <p role="status" className="text-sm text-success-text">
      {state.message}
    </p>
  );
}

/** Records what a creator replied. The class chosen decides the status and the next step. */
export function LogReplyForm({ campaignCreatorId }: { campaignCreatorId: string }) {
  const [state, action] = useActionState(logReply, null);
  const [replyClass, setReplyClass] = useState<ReplyClass | "">("");
  const id = `reply-${campaignCreatorId}`;

  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="campaignCreatorId" value={campaignCreatorId} />
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-class`}>What did the creator say?</Label>
        <NativeSelect
          id={`${id}-class`}
          name="replyClass"
          required
          value={replyClass}
          onChange={(event) => setReplyClass(event.target.value as ReplyClass | "")}
        >
          <option value="">Choose</option>
          {REPLY_CLASSES.map((value) => (
            <option key={value} value={value}>
              {REPLY_CLASS_LABELS[value]}
            </option>
          ))}
        </NativeSelect>
        {replyClass ? <p className="text-xs text-muted-foreground">{REPLY_OUTCOMES[replyClass].explains}</p> : null}
      </div>
      {replyClass === "rate_requested" ? (
        <div className="grid gap-1.5 sm:max-w-48">
          <Label htmlFor={`${id}-fee`}>Fee asked (US dollars)</Label>
          <Input id={`${id}-fee`} name="requestedFee" type="number" min={0} step={1} />
        </div>
      ) : null}
      {replyClass === "maybe_later" ? (
        <div className="grid gap-1.5 sm:max-w-48">
          <Label htmlFor={`${id}-date`}>Get back in touch on</Label>
          <Input id={`${id}-date`} name="reengageAfter" type="date" />
          <p className="text-xs text-muted-foreground">Leave empty for 60 days from now.</p>
        </div>
      ) : null}
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-text`}>Their message (optional)</Label>
        <Textarea id={`${id}-text`} name="text" rows={2} maxLength={5000} placeholder="Paste the reply to keep it on record" />
      </div>
      <FormError state={state} />
      <div className="flex items-center gap-3">
        <SubmitButton pendingLabel="Saving...">Log reply</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  );
}

/** Order number, tracking and delivery for one gift order. Each field moves the creator on by itself. */
export function GiftTrackingForm({
  gift,
}: {
  gift: { id: string; orderNumber: string | null; carrier: string | null; trackingNumber: string | null; delivered: boolean };
}) {
  const [state, action] = useActionState(updateGift, null);

  return (
    <form action={action} className="grid gap-2">
      <input type="hidden" name="giftId" value={gift.id} />
      <div className="grid gap-2 sm:grid-cols-4">
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          Amazon order number
          <Input name="orderNumber" defaultValue={gift.orderNumber ?? ""} className="h-8 text-sm text-foreground" />
        </label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          Carrier
          <Input name="carrier" defaultValue={gift.carrier ?? ""} placeholder="UPS, USPS..." className="h-8 text-sm text-foreground" />
        </label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          Tracking number
          <Input name="trackingNumber" defaultValue={gift.trackingNumber ?? ""} className="h-8 text-sm text-foreground" />
        </label>
        <label className="grid gap-1 text-xs font-medium text-muted-foreground">
          Delivered on
          <Input name="deliveredAt" type="date" disabled={gift.delivered} className="h-8 text-sm text-foreground" />
        </label>
      </div>
      <label className="grid gap-1 text-xs font-medium text-muted-foreground">
        Shipping problem (leave empty if none)
        <Input name="problem" placeholder="e.g. returned to sender, wrong address" className="h-8 text-sm text-foreground" />
      </label>
      <FormError state={state} />
      <div className="flex items-center gap-3">
        <SubmitButton size="sm" pendingLabel="Saving...">
          Save order details
        </SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  );
}

const POST_FORMATS = [
  ["reel", "Reel"],
  ["story", "Story"],
  ["post", "Feed post"],
  ["carousel", "Carousel"],
  ["video", "Video (YouTube / TikTok)"],
  ["short", "Short"],
  ["pin", "Pin"],
];

const POST_CHECKS = [
  ["mentionsBrand", "Brand is tagged"],
  ["productShown", "Correct product is shown"],
  ["hasDisclosure", "Gifted / ad disclosure is there"],
  ["collabInvite", "Collab or partnership invite added"],
];

/** Records a creator's live post with the four checks a reviewer makes. */
export function AddPostForm({ campaignCreatorId }: { campaignCreatorId: string }) {
  const [state, action] = useActionState(addPost, null);
  const id = `post-${campaignCreatorId}`;

  return (
    <form action={action} className="grid gap-3">
      <input type="hidden" name="campaignCreatorId" value={campaignCreatorId} />
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-url`}>Link to the post</Label>
          <Input id={`${id}-url`} name="url" type="url" required placeholder="https://www.instagram.com/reel/..." />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-format`}>Kind</Label>
          <NativeSelect id={`${id}-format`} name="format" defaultValue="reel">
            {POST_FORMATS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        {POST_CHECKS.map(([name, label]) => (
          <label key={name} className="flex items-center gap-1.5">
            <input type="checkbox" name={name} />
            {label}
          </label>
        ))}
      </div>
      <FormError state={state} />
      <div className="flex items-center gap-3">
        <SubmitButton pendingLabel="Saving...">Record post</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  );
}

/** Copies a creator's private selection link, for pasting into a message by hand. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          window.prompt("Copy this link:", text);
        }
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}

export function RunAutomationsButton() {
  const [state, action] = useActionState(runAutomationsNow, null);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <SubmitButton size="xs" variant="ghost" pendingLabel="Checking...">Refresh</SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}

const TIMINGS: { name: string; label: string }[] = [
  { name: "followUpAfterDays", label: "Days without a reply before a follow-up is due" },
  { name: "maxFollowUps", label: "Follow-ups before giving up" },
  { name: "closeAfterDays", label: "Days after the last follow-up before closing as No reply" },
  { name: "selectionWaitDays", label: "Days to wait for a product choice before nudging" },
  { name: "deliveryWaitDays", label: "Days after shipping before checking on delivery" },
  { name: "contentReminderDays", label: "Days after delivery before a content reminder" },
  { name: "contentDueDays", label: "Days after delivery before content is overdue" },
  { name: "noContentAfterDays", label: "Days overdue before closing as No content delivered" },
];

/** Admin: the waiting periods for one campaign, and which product types creators may choose. */
export function AutomationSettingsForm({
  campaignId,
  values,
  articles,
  chosenArticles,
}: {
  campaignId: string;
  values: Record<string, number>;
  articles: string[];
  chosenArticles: string[];
}) {
  const [state, action] = useActionState(saveCampaignAutomation, null);

  return (
    <form action={action} className="grid gap-4 p-4">
      <input type="hidden" name="campaignId" value={campaignId} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {TIMINGS.map((timing) => (
          <label key={timing.name} className="grid content-between gap-1 text-sm">
            <span>{timing.label}</span>
            <Input name={timing.name} type="number" min={0} step={1} required defaultValue={values[timing.name]} className="w-24" />
          </label>
        ))}
      </div>
      {articles.length > 0 ? (
        <fieldset>
          <legend className="text-sm font-medium">Products creators may choose</legend>
          <p className="mb-2 text-xs text-muted-foreground">Tick none to offer every giftable product of this brand.</p>
          <div className="flex max-h-40 flex-wrap gap-x-5 gap-y-1 overflow-y-auto">
            {articles.map((article) => (
              <label key={article} className="flex items-center gap-1.5">
                <input type="checkbox" name="giftArticles" value={article} defaultChecked={chosenArticles.includes(article)} />
                {article}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <FormError state={state} />
      <div className="flex items-center gap-3">
        <SubmitButton pendingLabel="Saving...">Save settings</SubmitButton>
        <FormMessage state={state} />
      </div>
    </form>
  );
}

function ImportNotes({ notes }: { notes?: string[] }) {
  if (!notes || notes.length === 0) return null;
  return (
    <ul className="list-disc pl-5 text-sm text-muted-foreground">
      {notes.map((note, index) => (
        <li key={index}>{note}</li>
      ))}
    </ul>
  );
}

/**
 * Opens Amazon's Category Listing Report in the browser and keeps only the
 * columns the portal uses. The workbook is several megabytes and hundreds of
 * columns wide; what is sent to the server is a small fraction of it.
 */
async function readListingReport(file: File) {
  const { read, utils } = await import("xlsx");
  const workbook = read(await file.arrayBuffer(), { sheets: LISTING_SHEET });
  const sheet = workbook.Sheets[LISTING_SHEET];
  if (!sheet) {
    return { error: `This Excel file has no "${LISTING_SHEET}" sheet, so it is not Amazon's Category Listing Report.` };
  }
  return readListingRows(utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false }));
}

/** Admin: upload a product list, a stock refresh, or Amazon's Category Listing Report for one brand. */
export function ProductUploadForm() {
  const [report, dispatch, pending] = useActionState(uploadProducts, null);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const file = formData.get("file");
    setReadError(null);

    if (file instanceof File && /\.xlsx$/i.test(file.name)) {
      setReading(true);
      try {
        const result = await readListingReport(file);
        if ("error" in result) {
          setReadError(result.error);
          return;
        }
        formData.delete("file");
        formData.set("listings", JSON.stringify(result.listings));
        formData.set("fileName", file.name);
      } catch {
        setReadError("The Excel file could not be opened. Download the report from Amazon again and upload it unchanged.");
        return;
      } finally {
        setReading(false);
      }
    } else if (file instanceof File && /\.xls$/i.test(file.name)) {
      setReadError("Old-style .xls files are not supported. Upload the .xlsx file Amazon produced, or a CSV file.");
      return;
    }
    startTransition(() => dispatch(formData));
  }

  const error = readError ?? report?.error;

  return (
    <form onSubmit={onSubmit} className="grid gap-3 p-4">
      <div className="grid gap-3 sm:grid-cols-[14rem_minmax(0,1fr)]">
        <div className="grid gap-1.5">
          <Label htmlFor="product-brand">Brand</Label>
          <NativeSelect id="product-brand" name="brandId" required defaultValue="">
            <option value="" disabled>
              Choose
            </option>
            {BRANDS.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="product-file">File from Amazon, or a CSV</Label>
          <Input id="product-file" name="file" type="file" accept=".xlsx,.csv,.txt,.tsv,text/csv,text/plain" required />
        </div>
      </div>
      {error ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-danger-soft px-3 py-2 text-danger-text">
          {error}
        </p>
      ) : null}
      {!error && report?.headline ? (
        <p role="status" className="rounded-md bg-success-soft px-3 py-2 text-success-text">
          {report.headline}
        </p>
      ) : null}
      {!error ? <ImportNotes notes={report?.notes} /> : null}
      <div>
        <SubmitButton variant="action" pending={reading || pending} pendingLabel={reading ? "Reading the file..." : "Importing..."}>
          Import products
        </SubmitButton>
      </div>
    </form>
  );
}

/** Admin: switch every product in the current search on or off for creators. */
export function OfferListForm({ filter, total }: { filter: { q: string; brand: string; view: string }; total: number }) {
  const [state, action] = useActionState(setOfferedForList, null);
  const ask = (question: string) => (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!window.confirm(question)) event.preventDefault();
  };

  // After a switch the list can be empty (everything moved to another status); the result stays on screen.
  if (total === 0 && !state) return null;

  return (
    <form action={action} className="flex flex-wrap items-center gap-2 border-b bg-surface-2 px-4 py-2.5">
      <input type="hidden" name="q" value={filter.q} />
      <input type="hidden" name="brand" value={filter.brand} />
      <input type="hidden" name="view" value={filter.view} />
      {total > 0 ? (
        <>
          <span>
            All <strong className="tabular-nums">{total}</strong> in this list:
          </span>
          <Button type="submit" name="offered" value="yes" size="sm" onClick={ask(`Offer all ${total} products in this list to creators?`)}>
            Offer to creators
          </Button>
          <Button type="submit" name="offered" value="no" size="sm" onClick={ask(`Stop offering all ${total} products in this list to creators?`)}>
            Stop offering
          </Button>
        </>
      ) : null}
      {state?.error ? (
        <span role="alert" className="text-danger-text">
          {state.error}
        </span>
      ) : null}
      <FormMessage state={state} />
    </form>
  );
}

/** Paste or upload order numbers, tracking and delivery dates for many gift orders at once. */
export function TrackingImportForm() {
  const [report, action] = useActionState(importTracking, null);

  return (
    <form action={action} className="grid gap-3 pt-3">
      <div className="grid gap-1.5">
        <Label htmlFor="tracking-file">CSV file</Label>
        <Input id="tracking-file" name="file" type="file" accept=".csv,text/csv" />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="tracking-pasted">Or paste rows</Label>
        <Textarea
          id="tracking-pasted"
          name="pasted"
          rows={4}
          className="font-mono text-xs"
          placeholder={"reference,order_number,carrier,tracking_number,delivered_date\nCGE-ABC123XYZ0,S01-1234567-1234567,UPS,1Z999...,2026-10-12"}
        />
      </div>
      {report?.error ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-danger-soft px-3 py-2 text-danger-text">
          {report.error}
        </p>
      ) : null}
      {report && !report.error ? (
        <p role="status" className="rounded-md bg-success-soft px-3 py-2 text-success-text">
          {report.updated} gift orders updated.
        </p>
      ) : null}
      <ImportNotes notes={report?.notes} />
      <div>
        <SubmitButton pendingLabel="Updating...">Update tracking</SubmitButton>
      </div>
    </form>
  );
}
