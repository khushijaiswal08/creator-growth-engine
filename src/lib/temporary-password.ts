import { randomBytes } from "node:crypto";

/** How long a temporary password works before the person needs a new one. */
const TEMP_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000;

/** A fresh temporary password: 12 characters of letters, digits, - and _. */
export function temporaryPassword(): string {
  return randomBytes(9).toString("base64url");
}

/** When a temporary password issued now stops working. */
export function temporaryPasswordExpiry(now = Date.now()): Date {
  return new Date(now + TEMP_PASSWORD_TTL_MS);
}
