import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Shipping details are encrypted before they reach the database and decrypted
 * only when a signed-in person of that brand needs them (the orders page and
 * the Amazon order file). AES-256-GCM with a key that lives only in the server
 * environment (ADDRESS_ENCRYPTION_KEY, 32 random bytes in base64). Values are
 * stored as "enc:v1:<iv>:<tag>:<ciphertext>" in base64url, so a value without
 * that prefix (older rows, placeholders) is passed through unchanged.
 */
const PREFIX = "enc:v1:";

export const ADDRESS_FIELDS = ["shipName", "address1", "address2", "city", "state", "postalCode", "phone"] as const;
export type AddressField = (typeof ADDRESS_FIELDS)[number];

let cachedKey: Buffer | null | undefined;

function key(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const raw = process.env.ADDRESS_ENCRYPTION_KEY?.trim();
  if (!raw) {
    cachedKey = null;
    return null;
  }
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) throw new Error("ADDRESS_ENCRYPTION_KEY must be 32 random bytes in base64.");
  cachedKey = bytes;
  return bytes;
}

/** True when a key is set, so new addresses are written encrypted. */
export function addressEncryptionEnabled(): boolean {
  return key() !== null;
}

/** For tests: forget the cached key after changing the environment. */
export function resetAddressKey(): void {
  cachedKey = undefined;
}

export function seal(value: string): string {
  const k = key();
  if (!k || value === "") return value;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${body.toString("base64url")}`;
}

export function open(value: string): string {
  if (!value.startsWith(PREFIX)) return value;
  const k = key();
  if (!k) throw new Error("A stored address is encrypted but ADDRESS_ENCRYPTION_KEY is not set.");
  const [iv, tag, body] = value.slice(PREFIX.length).split(":");
  const decipher = createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

type AddressLike = { [K in AddressField]: string | null };

/** Encrypts every address field of a gift order about to be written. */
export function sealAddress<T extends AddressLike>(order: T): T {
  const out = { ...order };
  for (const field of ADDRESS_FIELDS) {
    const value = order[field];
    if (typeof value === "string") out[field] = seal(value) as T[typeof field];
  }
  return out;
}

/** Decrypts the address fields of a gift order read from the database. Other fields are untouched. */
export function openAddress<T extends Partial<AddressLike>>(order: T): T {
  const out = { ...order };
  for (const field of ADDRESS_FIELDS) {
    const value = order[field];
    if (typeof value === "string") out[field] = open(value) as T[typeof field];
  }
  return out;
}
