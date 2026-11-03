import { headers } from "next/headers";

/** The site's public address: APP_URL when set, otherwise taken from the current request. */
export async function appBaseUrl(): Promise<string> {
  const configured = process.env.APP_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const incoming = await headers();
  const host = incoming.get("x-forwarded-host") ?? incoming.get("host") ?? "localhost:3000";
  const protocol = incoming.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${protocol}://${host}`;
}
