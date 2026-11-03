"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { finishUpload, signUpload, startUpload, type UploadRequest } from "@/lib/content-upload";
import { callerIp, hitRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

const TOO_MANY_UPLOADS = "Too many uploads in a short time. Please try again in an hour.";

/**
 * PUBLIC: called from the creator's content-upload page, with no sign-in.
 * Every check lives in src/lib/content-upload.ts; this only slows down
 * anyone hammering it, per connection and per link.
 */
export async function startContentUpload(token: string, request: UploadRequest): Promise<{ ok: true; assetIds: string[] } | { ok: false; error: string }> {
  const link = String(token ?? "");
  if ((await hitRateLimit(RATE_LIMITS.uploadStart, callerIp(await headers()))) || (await hitRateLimit(RATE_LIMITS.uploadStartLink, link))) {
    return { ok: false, error: TOO_MANY_UPLOADS };
  }
  return startUpload(link, {
    files: Array.isArray(request?.files) ? request.files : [],
    usage: String(request?.usage ?? ""),
    postUrl: String(request?.postUrl ?? ""),
    postedOn: String(request?.postedOn ?? ""),
    note: String(request?.note ?? ""),
  });
}

/** PUBLIC: the address to send one file to, asked for just before that file goes up. */
export async function signContentUpload(token: string, assetId: string): Promise<{ ok: true; url: string; headers: Record<string, string> } | { ok: false; error: string }> {
  if (await hitRateLimit(RATE_LIMITS.uploadFile, callerIp(await headers()))) return { ok: false, error: TOO_MANY_UPLOADS };
  return signUpload(String(token ?? ""), String(assetId ?? ""));
}

/** PUBLIC: the browser reports a file it finished sending; it is checked in storage before it counts. */
export async function finishContentUpload(token: string, assetIds: string[]): Promise<{ ok: true; received: number; missing: number } | { ok: false; error: string }> {
  if (await hitRateLimit(RATE_LIMITS.uploadFile, callerIp(await headers()))) return { ok: false, error: TOO_MANY_UPLOADS };
  const result =await finishUpload(String(token ?? ""), Array.isArray(assetIds) ? assetIds.map(String) : []);
  if (result.ok) {
    revalidatePath("/content");
    revalidatePath("/today");
  }
  return result;
}
