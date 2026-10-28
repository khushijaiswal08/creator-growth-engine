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
import { AMAZON_CONSOLE_URL, defaultDestination, destinationsFor, mailtoFor, pickTemplate, type Destination } from "@/lib/channels";
import { messageUrl } from "@/lib/profile-url";
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
  /** The template the next action calls for, when the caller knows it. */
  purpose?: TemplatePurpose | null;
  /** The creator's email, when known: offers the email channel. */
  email?: string | null;
  /** A Creator Connections creator: offers the Amazon channel. */
  amazonCreator?: boolean;
};

const OpenComposer = createContext<((target: MessageTarget) => void) | null>(null);

/** For buttons that are not the standard MessageButton: opens the composer of the nearest MessageComposer. */
export function useOpenComposer(): ((target: MessageTarget) => void) | null {
  return useContext(OpenComposer);
}

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

export function MessageButton({
  target,
  label = "Message",
  icon,
  size = "xs",
  variant = "outline",
  className,
}: {
  target: MessageTarget;
  /** The verb on the button, when "Message" is not the clearest word ("Reply", "Send link"). */
  label?: string;
  /** An icon before the label. */
  icon?: React.ReactNode;
  size?: "xs" | "sm" | "default";
  variant?: "outline" | "action" | "link" | "ghost" | "soft";
  className?: string;
}) {
  const open = useContext(OpenComposer);

  if (target.blockedReason) {
    return (
      <span className="text-xs text-muted-foreground" title={target.blockedReason}>
        Do not contact
      </span>
    );
  }
  if (destinationsFor(target).length === 0) {
    return <span className="text-xs text-muted-foreground">No way to reach</span>;
  }
  return (
    <Button type="button" size={size} variant={variant} disabled={!open} onClick={() => open?.(target)} className={className}>
      {icon}
      {label}
    </Button>
  );
}

type Outcome = {
  url: string;
  channel: Destination["channel"];
  copied: boolean;
  opened: boolean;
  logged: { ok: true; movedToContacted: boolean } | { ok: false; error: string };
};

type Allowed = { ok: true; brand: string; selectionUrl: string; email: string | null; amazonCreator: boolean; creatorConnectionsUrl: string | null } | { ok: false; error: string };

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
  const preferred: TemplatePurpose = target.purpose
    ? target.purpose
    : PRE_CONTACT_STATUSES.has(target.status)
      ? "first"
      : target.status === "interested" || target.status === "agreed"
        ? "selection"
        : target.status === "content_expected"
          ? "reminder"
          : "followup";
  // null while the server re-checks the suppression list for this creator.
  const [allowed, setAllowed] = useState<Allowed | null>(null);
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

  // The ways to reach them: what the caller knew, widened by what the server knows (email, Creator Connections).
  const destinations = destinationsFor({
    profiles: target.profiles,
    email: target.email ?? (allowed?.ok ? allowed.email : null),
    amazonCreator: target.amazonCreator || (allowed?.ok ? allowed.amazonCreator : false),
  });
  const [destinationKey, setDestinationKey] = useState<string | null>(null);
  const destination = destinations.find((item) => item.key === destinationKey) ?? defaultDestination(destinations, target.status);

  const [templateId, setTemplateId] = useState(() => pickTemplate(templates, preferred, defaultDestination(destinationsFor(target), target.status)?.channel ?? "dm")?.id ?? "");
  const [product, setProduct] = useState(readLastProduct);
  // Manual edits to the message; cleared when a choice above changes.
  const [edited, setEdited] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const template = templates.find((t) => t.id === templateId);

  const body =
    edited ??
    (template && destination
      ? fillTemplate(template.body, {
          name: firstName(target.influencerName),
          handle: destination.handle ?? "",
          platform: destination.platformWord,
          sender: senderName,
          product,
          brand: allowed?.ok ? allowed.brand : "",
          selection_link: allowed?.ok ? allowed.selectionUrl : "",
        })
      : "");
  const unfilled = remainingPlaceholders(body);
  const where = destination?.channel === "amazon" ? "Amazon Creator Connections" : destination?.channel === "email" ? "your mail app" : destination?.platform === "instagram" ? "Instagram DM" : destination ? `${destination.platformWord} profile` : "";
  const verb = destination?.channel === "email" ? "Open mail app" : `Copy and open ${where}`;

  function chooseDestination(key: string) {
    setDestinationKey(key);
    const next = destinations.find((item) => item.key === key);
    setTemplateId(pickTemplate(templates, preferred, next?.channel ?? "dm")?.id ?? "");
    setEdited(null);
  }

  function copyAndOpen() {
    if (!destination) return;
    const text = body;
    const url =
      destination.channel === "dm" && destination.platform && destination.handle
        ? messageUrl(destination.platform, destination.handle)
        : destination.channel === "amazon"
          ? (allowed?.ok && allowed.creatorConnectionsUrl) || AMAZON_CONSOLE_URL
          : mailtoFor(destination.email ?? "", allowed?.ok ? `A gift from ${allowed.brand}` : "A gift for you", text);

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

    let opened = false;
    if (destination.channel === "email") {
      // A mail link hands the message to the mail app and leaves the portal where it is.
      window.location.assign(url);
      opened = true;
    } else {
      const tab = window.open(url, "_blank");
      if (tab) tab.opener = null;
      opened = tab !== null;
    }

    saveLastProduct(product);

    startTransition(async () => {
      const [copiedLate, logged] = await Promise.all([
        clipboardWrite ?? copied,
        logOutboundMessage({
          campaignCreatorId: target.campaignCreatorId,
          channel: destination.channel,
          socialProfileId: destination.socialProfileId,
          templateId: template?.id ?? null,
          body: text,
        }),
      ]);
      setOutcome({ url, channel: destination.channel, copied: copiedLate, opened, logged });
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
          <li>{outcome.copied ? "Message copied to the clipboard." : "The message could not be copied. Copy it by hand from the box below."}</li>
          {outcome.channel === "email" ? (
            <li>
              Your mail app should have opened with the message ready.{" "}
              <a href={outcome.url} className="link underline">
                Open it again
              </a>
            </li>
          ) : outcome.channel === "amazon" ? (
            <li>
              {outcome.opened ? "Amazon opened in a new tab. " : "Your browser blocked the new tab. "}
              In Creator Connections, open the campaign, find {firstName(target.influencerName)} and paste the message into the thread.{" "}
              <a href={outcome.url} target="_blank" rel="noopener noreferrer" className="link underline">
                Open Amazon
              </a>
            </li>
          ) : (
            <li>
              {outcome.opened ? `${where} opened in a new tab. ` : "Your browser blocked the new tab. "}
              <a href={outcome.url} target="_blank" rel="noopener noreferrer" className="link underline">
                Open {where}
              </a>
            </li>
          )}
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
          {destination?.channel === "email" ? "Opens your mail app with the message ready. " : `Copies the message and opens ${where || "the profile"}. `}
          Nothing is sent automatically.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="grid gap-1.5">
          <Label htmlFor="msg-destination">Send via</Label>
          <NativeSelect id="msg-destination" value={destination?.key ?? ""} onChange={(event) => chooseDestination(event.target.value)}>
            {destinations.length === 0 ? <option value="">No way to reach</option> : null}
            {destinations.map((item) => (
              <option key={item.key} value={item.key}>
                {item.label}
              </option>
            ))}
          </NativeSelect>
        </div>
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
            "Edited by hand. Changing the channel, template or product resets your edits."
          ) : destination?.channel === "amazon" ? (
            "Amazon opens in a new tab. Open the campaign there, find the creator and paste the message into the thread."
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
          disabled={pending || !allowed?.ok || !destination || !body.trim() || unfilled.length > 0}
          onClick={copyAndOpen}
        >
          {pending ? "Logging..." : allowed === null ? "Checking..." : verb}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
