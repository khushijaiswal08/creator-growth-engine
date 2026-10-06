"use client";

import type { CreatorStatus, Platform, TemplatePurpose } from "@prisma/client";
import { createContext, useContext, useEffect, useRef, useState, useTransition } from "react";
import { checkMessageAllowed, logOutboundMessage } from "@/actions/messages";
import { NativeSelect } from "@/components/native-select";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { displayHandle, messageUrl, PLATFORM_LABELS } from "@/lib/profile-url";
import { PRE_CONTACT_STATUSES } from "@/lib/status";
import { fillTemplate, firstName, remainingPlaceholders } from "@/lib/template";

export type MessageTemplate = { id: string; name: string; purpose: TemplatePurpose; body: string };

export type MessageTarget = {
  campaignCreatorId: string;
  influencerName: string;
  status: CreatorStatus;
  profiles: { id: string; platform: Platform; handle: string }[];
  /** Why this creator must not be messaged (suppression list, blocked status, archived). */
  blockedReason: string | null;
};

const OpenComposer = createContext<((target: MessageTarget) => void) | null>(null);

const PRODUCT_KEY = "cge:last-product";

function readLastProduct(): string {
  try {
    return window.localStorage.getItem(PRODUCT_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLastProduct(value: string) {
  try {
    window.localStorage.setItem(PRODUCT_KEY, value);
  } catch {
    // Storage can be unavailable (private window); the field just starts empty next time.
  }
}

/**
 * Wrap a table in this once; every MessageButton inside opens the same dialog.
 * Keeps the template list out of each row.
 */
export function MessageComposer({
  templates,
  senderName,
  children,
}: {
  templates: MessageTemplate[];
  senderName: string;
  children: React.ReactNode;
}) {
  const [target, setTarget] = useState<MessageTarget | null>(null);

  return (
    <OpenComposer.Provider value={setTarget}>
      {children}
      <Dialog open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
        {target ? (
          <ComposerDialog
            key={target.campaignCreatorId}
            target={target}
            templates={templates}
            senderName={senderName}
            onClose={() => setTarget(null)}
          />
        ) : null}
      </Dialog>
    </OpenComposer.Provider>
  );
}

export function MessageButton({ target }: { target: MessageTarget }) {
  const open = useContext(OpenComposer);

  if (target.blockedReason) {
    return (
      <span className="text-xs text-muted-foreground" title={target.blockedReason}>
        Do not contact
      </span>
    );
  }
  if (target.profiles.length === 0) {
    return <span className="text-xs text-muted-foreground">No profile</span>;
  }
  return (
    <Button type="button" size="xs" variant="outline" disabled={!open} onClick={() => open?.(target)}>
      Message
    </Button>
  );
}

type Outcome = {
  url: string;
  copied: boolean;
  opened: boolean;
  logged: { ok: true; movedToContacted: boolean } | { ok: false; error: string };
};

function ComposerDialog({
  target,
  templates,
  senderName,
  onClose,
}: {
  target: MessageTarget;
  templates: MessageTemplate[];
  senderName: string;
  onClose: () => void;
}) {
  // The template that fits where this creator is in the journey.
  const preferred: TemplatePurpose = PRE_CONTACT_STATUSES.has(target.status)
    ? "first"
    : target.status === "interested" || target.status === "agreed"
      ? "selection"
      : target.status === "content_expected"
        ? "reminder"
        : "followup";
  // null while the server re-checks the suppression list for this creator.
  const [allowed, setAllowed] = useState<{ ok: true; brand: string; selectionUrl: string } | { ok: false; error: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    checkMessageAllowed(target.campaignCreatorId).then(
      (result) => !cancelled && setAllowed(result),
      () => !cancelled && setAllowed({ ok: false, error: "Could not check the suppression list. Try again." }),
    );
    return () => {
      cancelled = true;
    };
  }, [target.campaignCreatorId]);

  const [templateId, setTemplateId] = useState(
    () => (templates.find((t) => t.purpose === preferred) ?? templates[0])?.id ?? "",
  );
  const [profileId, setProfileId] = useState(target.profiles[0].id);
  const [product, setProduct] = useState(readLastProduct);
  // Manual edits to the message; cleared when a choice above changes.
  const [edited, setEdited] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const template = templates.find((t) => t.id === templateId);
  const profile = target.profiles.find((p) => p.id === profileId) ?? target.profiles[0];
  const platformLabel = PLATFORM_LABELS[profile.platform];

  const body =
    edited ??
    (template
      ? fillTemplate(template.body, {
          name: firstName(target.influencerName),
          handle: profile.handle,
          platform: platformLabel,
          sender: senderName,
          product,
          brand: allowed?.ok ? allowed.brand : "",
          selection_link: allowed?.ok ? allowed.selectionUrl : "",
        })
      : "");
  const unfilled = remainingPlaceholders(body);
  const destination = profile.platform === "instagram" ? "Instagram DM" : `${platformLabel} profile`;

  function copyAndOpen() {
    const url = messageUrl(profile.platform, profile.handle);
    const text = body;

    // Copy and open must both happen synchronously inside the click, or browsers
    // block them. execCommand is synchronous; the async Clipboard API is the fallback.
    let copied = false;
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.focus();
      textarea.select();
      try {
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      }
      textarea.setSelectionRange(0, 0);
    }
    const clipboardWrite = copied
      ? null
      : navigator.clipboard?.writeText(text).then(
          () => true,
          () => false,
        );

    const opened = window.open(url, "_blank");
    if (opened) opened.opener = null;

    saveLastProduct(product);

    startTransition(async () => {
      const [copiedLate, logged] = await Promise.all([
        clipboardWrite ?? copied,
        logOutboundMessage({
          campaignCreatorId: target.campaignCreatorId,
          socialProfileId: profile.id,
          templateId: template?.id ?? null,
          body: text,
        }),
      ]);
      setOutcome({ url, copied: copiedLate, opened: opened !== null, logged });
    });
  }

  if (outcome) {
    return (
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Message for {target.influencerName}</DialogTitle>
          <DialogDescription>Nothing is sent automatically. Paste the message and send it yourself.</DialogDescription>
        </DialogHeader>
        <ul className="grid gap-2 text-sm">
          <li>
            {outcome.copied
              ? "Message copied to the clipboard."
              : "The message could not be copied. Copy it by hand from the box below."}
          </li>
          <li>
            {outcome.opened ? `${destination} opened in a new tab. ` : "Your browser blocked the new tab. "}
            <a href={outcome.url} target="_blank" rel="noopener noreferrer" className="link underline">
              Open {destination}
            </a>
          </li>
          <li className={outcome.logged.ok ? undefined : "text-destructive"} role={outcome.logged.ok ? undefined : "alert"}>
            {outcome.logged.ok
              ? outcome.logged.movedToContacted
                ? "Logged. Status moved to Contacted."
                : "Logged. Status unchanged."
              : `Not logged: ${outcome.logged.error}`}
          </li>
        </ul>
        {outcome.copied ? null : <Textarea readOnly value={body} rows={8} className="text-sm" />}
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    );
  }

  return (
    <DialogContent className="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>Message {target.influencerName}</DialogTitle>
        <DialogDescription>
          Copies the message and opens the {destination}. Nothing is sent automatically.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="msg-template">Template</Label>
          <NativeSelect
            id="msg-template"
            value={templateId}
            onChange={(event) => {
              setTemplateId(event.target.value);
              setEdited(null);
            }}
          >
            {templates.length === 0 ? <option value="">No templates</option> : null}
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="msg-profile">Profile</Label>
          <NativeSelect
            id="msg-profile"
            value={profile.id}
            onChange={(event) => {
              setProfileId(event.target.value);
              setEdited(null);
            }}
          >
            {target.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {PLATFORM_LABELS[p.platform]} {displayHandle(p.handle)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="msg-product">Product</Label>
          <Input
            id="msg-product"
            value={product}
            placeholder="e.g. our block-print tablecloth"
            onChange={(event) => {
              setProduct(event.target.value);
              setEdited(null);
            }}
          />
        </div>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="msg-body">Message</Label>
        <Textarea
          id="msg-body"
          ref={textareaRef}
          value={body}
          rows={11}
          className="text-sm"
          onChange={(event) => setEdited(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          {unfilled.length > 0 ? (
            <span className="text-destructive">
              Still to fill in: {unfilled.map((name) => `{${name}}`).join(", ")}.
            </span>
          ) : edited !== null ? (
            "Edited by hand. Changing the template, profile or product resets your edits."
          ) : (
            "You can edit the text before copying."
          )}
        </p>
      </div>

      {allowed && !allowed.ok ? (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          Do not contact. {allowed.error}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="action"
          disabled={pending || !allowed?.ok || !body.trim() || unfilled.length > 0}
          onClick={copyAndOpen}
        >
          {pending ? "Logging..." : allowed === null ? "Checking..." : `Copy and open ${destination}`}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
