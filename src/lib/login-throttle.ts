import { createHash } from "node:crypto";
import { db } from "@/lib/db";

/** 5 failed sign-ins per email + IP in 15 minutes, then that pair is locked until the window passes. */
export const MAX_FAILED_ATTEMPTS = 5;
export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const PURGE_AFTER_MS = 24 * 60 * 60 * 1000;

/** The caller's address as the platform reports it. Vercel sets x-forwarded-for itself. */
export function clientIp(request: Request | undefined): string {
  const forwarded = request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request?.headers.get("x-real-ip")?.trim() || "unknown";
}

/** One-way key for an email + IP pair, so neither is stored in readable form. */
export function throttleKey(email: string, ip: string): string {
  return createHash("sha256").update(`${email.trim().toLowerCase()}|${ip}`).digest("hex");
}

export async function isLockedOut(key: string, now = new Date()): Promise<boolean> {
  const failures = await db.loginAttempt.count({
    where: { key, createdAt: { gt: new Date(now.getTime() - ATTEMPT_WINDOW_MS) } },
  });
  return failures >= MAX_FAILED_ATTEMPTS;
}

export async function recordFailedAttempt(key: string, now = new Date()): Promise<void> {
  await db.loginAttempt.create({ data: { key, createdAt: now } });
  // Housekeeping: old rows are no use to anyone.
  await db.loginAttempt.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - PURGE_AFTER_MS) } } });
}

export async function clearFailedAttempts(key: string): Promise<void> {
  await db.loginAttempt.deleteMany({ where: { key } });
}
