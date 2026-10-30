import { createHash } from "node:crypto";
import { db } from "@/lib/db";

/**
 * A small rate limiter for the public pages, kept in the database so it works
 * the same across serverless instances. Keys are hashed, so no address or
 * token is stored in readable form.
 */
export type RateLimitRule = { name: string; max: number; windowMs: number };

export const RATE_LIMITS = {
  /** Opening selection links, per caller address. */
  selectionView: { name: "selection-view", max: 60, windowMs: 10 * 60 * 1000 },
  /** Opening links that do not exist, per caller address: guessing tokens. */
  selectionMiss: { name: "selection-miss", max: 10, windowMs: 60 * 60 * 1000 },
  /** Submitting a choice, per caller address. */
  selectionSubmit: { name: "selection-submit", max: 5, windowMs: 60 * 60 * 1000 },
  /** Opening content-upload links, per caller address. */
  uploadView: { name: "upload-view", max: 60, windowMs: 10 * 60 * 1000 },
  /** Opening upload links that do not exist, per caller address. */
  uploadMiss: { name: "upload-miss", max: 10, windowMs: 60 * 60 * 1000 },
  /** Starting a batch of file uploads, per caller address (each batch can hold several files). */
  uploadStart: { name: "upload-start", max: 15, windowMs: 60 * 60 * 1000 },
  /** Starting a batch, per upload link, so a forwarded link cannot be used from many addresses at once. */
  uploadStartLink: { name: "upload-start-link", max: 20, windowMs: 60 * 60 * 1000 },
  /** Asking for a file's upload address, and reporting it sent, per caller address (once per file each). */
  uploadFile: { name: "upload-file", max: 300, windowMs: 60 * 60 * 1000 },
} satisfies Record<string, RateLimitRule>;

const PURGE_AFTER_MS = 24 * 60 * 60 * 1000;

/** The caller's address as the platform reports it (Netlify and Vercel both set x-forwarded-for). */
export function callerIp(headers: Headers): string {
  const netlify = headers.get("x-nf-client-connection-ip")?.trim();
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return netlify || forwarded || headers.get("x-real-ip")?.trim() || "unknown";
}

export function rateLimitKey(rule: RateLimitRule, subject: string): string {
  return createHash("sha256").update(`${rule.name}|${subject}`).digest("hex");
}

/** True when the subject has already used up its allowance for this rule. */
export async function isRateLimited(rule: RateLimitRule, subject: string, now = new Date()): Promise<boolean> {
  const hits = await db.rateLimitHit.count({
    where: { key: rateLimitKey(rule, subject), createdAt: { gt: new Date(now.getTime() - rule.windowMs) } },
  });
  return hits >= rule.max;
}

/** Counts one use. Call after the check, for the requests that were let through too. */
export async function recordHit(rule: RateLimitRule, subject: string, now = new Date()): Promise<void> {
  await db.rateLimitHit.create({ data: { key: rateLimitKey(rule, subject), createdAt: now } });
  // Housekeeping, now and then: old rows are no use to anyone.
  if (Math.random() < 0.05) {
    await db.rateLimitHit.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - PURGE_AFTER_MS) } } });
  }
}

/** Check and count in one go. Returns true when the request must be refused. */
export async function hitRateLimit(rule: RateLimitRule, subject: string, now = new Date()): Promise<boolean> {
  if (await isRateLimited(rule, subject, now)) return true;
  await recordHit(rule, subject, now);
  return false;
}
