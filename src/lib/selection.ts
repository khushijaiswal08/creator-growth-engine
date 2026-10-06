import { randomBytes } from "node:crypto";
import { headers } from "next/headers";
import { db } from "@/lib/db";

/** A selection link works for this many days after it is made. */
export const SELECTION_LINK_DAYS = 14;

const DAY = 24 * 60 * 60 * 1000;

/** The site's public address: APP_URL when set, otherwise taken from the current request. */
export async function appBaseUrl(): Promise<string> {
  const configured = process.env.APP_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") ?? incoming.get("host") ?? "localhost:3000";
  const protocol = incoming.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${protocol}://${host}`;
}

/** 192 random bits, URL-safe. Cannot be guessed; nothing about the creator is in it. */
export function newSelectionToken(): string {
  return randomBytes(24).toString("base64url");
}

/** True when a link is past its expiry or has already been used. */
export function selectionLinkExpired(creator: { selectionExpiresAt: Date | null; selectionUsedAt: Date | null }, now = new Date()): boolean {
  if (creator.selectionUsedAt) return true;
  // A link made before expiry existed is treated as expired, so every live link has a date.
  if (!creator.selectionExpiresAt) return true;
  return creator.selectionExpiresAt.getTime() <= now.getTime();
}

/**
 * The creator's private product-selection link. The token is long and random,
 * so the link cannot be guessed. It is reused while it is still valid; an
 * expired or used link is replaced by a fresh one with a new expiry.
 */
export async function ensureSelectionUrl(campaignCreatorId: string, now = new Date()): Promise<string> {
  const existing = await db.campaignCreator.findUnique({
    where: { id: campaignCreatorId },
    select: { selectionToken: true, selectionExpiresAt: true, selectionUsedAt: true },
  });
  let token = existing?.selectionToken ?? null;
  if (!token || !existing || selectionLinkExpired(existing, now)) {
    token = newSelectionToken();
    await db.campaignCreator.update({
      where: { id: campaignCreatorId },
      data: { selectionToken: token, selectionExpiresAt: new Date(now.getTime() + SELECTION_LINK_DAYS * DAY), selectionUsedAt: null },
    });
  }
  return `${await appBaseUrl()}/select/${token}`;
}
