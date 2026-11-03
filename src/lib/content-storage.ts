import { createHmac, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ContentKind } from "@prisma/client";

/**
 * Where creators' original files live. Server-side only.
 *
 *   s3     Any S3-compatible bucket (Cloudflare R2 is the plan: free up to
 *          10 GB, no download fees). Set CONTENT_S3_ENDPOINT, CONTENT_S3_BUCKET,
 *          CONTENT_S3_ACCESS_KEY_ID and CONTENT_S3_SECRET_ACCESS_KEY
 *          (CONTENT_S3_REGION defaults to "auto", which R2 expects).
 *   local  A folder on this computer, for the test copy only. Never used in
 *          production: a server's own disk does not keep files.
 *
 * Either way the browser sends the bytes straight to storage with a short-
 * lived signed address, so large videos never pass through a Netlify function,
 * and the team views them through signed addresses too: the bucket stays private.
 */
type StorageMode = "s3" | "local";

/** Largest single file a creator may send: 2 GB, the figure the upload page quotes. */
export const MAX_FILE_BYTES = 2_000_000_000;
export const MAX_FILES_PER_UPLOAD = 20;
/**
 * Each file's upload address is made just before that file goes up, and a
 * request only has to start before it expires, so a short life is enough
 * even for a 2 GB video on a slow line.
 */
const UPLOAD_SECONDS = 15 * 60;
const VIEW_SECONDS = 60 * 60;

const VIDEO_EXTENSIONS: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", m4v: "video/x-m4v", webm: "video/webm", avi: "video/x-msvideo", "3gp": "video/3gpp" };
const PHOTO_EXTENSIONS: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", heic: "image/heic", heif: "image/heif", webp: "image/webp", gif: "image/gif" };
/** The only types a file is ever stored or served as. Anything else (SVG, HTML, "image/png, text/html") is refused. */
const ALLOWED_TYPES = new Map<string, ContentKind>([
  ...Object.values(VIDEO_EXTENSIONS).map((type) => [type, "video"] as const),
  ...Object.values(PHOTO_EXTENSIONS).map((type) => [type, "photo"] as const),
]);

/** True for a stored type the app may hand to a browser as is. */
export function isAllowedType(contentType: string): boolean {
  return ALLOWED_TYPES.has(contentType);
}

type S3Config = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: string };

function s3Config(): S3Config | null {
  const endpoint = process.env.CONTENT_S3_ENDPOINT?.trim();
  const bucket = process.env.CONTENT_S3_BUCKET?.trim();
  const accessKeyId = process.env.CONTENT_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.CONTENT_S3_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint, bucket, accessKeyId, secretAccessKey, region: process.env.CONTENT_S3_REGION?.trim() || "auto" };
}

/** Which storage is in use, or null when uploads are not set up (production without bucket keys). */
export function storageMode(): StorageMode | null {
  if (s3Config()) return "s3";
  return process.env.NODE_ENV === "production" ? null : "local";
}

let client: S3Client | null = null;
function s3(): { client: S3Client; bucket: string } {
  const config = s3Config();
  if (!config) throw new Error("Content storage is not configured.");
  client ??= new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    // Recent SDKs put a checksum into signed upload addresses by default; a browser cannot send it and R2
    // does not expect it, so checksums are only added where the service requires them.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return { client, bucket: config.bucket };
}

/**
 * The file's kind and the exact type to store it with, from a fixed list.
 * The browser's type counts only when it is exactly one of those; otherwise
 * the extension decides (phones often send no type for videos). The browser's
 * text is never stored, so a file cannot pass itself off as something a
 * browser would run. Null for anything that is not a video or a photo.
 */
export function classifyFile(fileName: string, browserType: string): { kind: ContentKind; contentType: string } | null {
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  const type = browserType.toLowerCase().trim();
  const exact = ALLOWED_TYPES.get(type);
  if (exact) return { kind: exact, contentType: type };
  if (VIDEO_EXTENSIONS[extension]) return { kind: "video", contentType: VIDEO_EXTENSIONS[extension] };
  if (PHOTO_EXTENSIONS[extension]) return { kind: "photo", contentType: PHOTO_EXTENSIONS[extension] };
  return null;
}

/** "My Reel (final).MOV" -> "my-reel-final.mov": safe in a storage key and a download name. */
export function safeFileName(fileName: string): string {
  const cleaned = fileName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return (cleaned || "file").slice(-80);
}

export function storageKeyFor(brandId: string, campaignCreatorId: string, assetId: string, fileName: string): string {
  return `content/${brandId}/${campaignCreatorId}/${assetId}/${safeFileName(fileName)}`;
}

// --- Local test storage: a folder, with addresses signed like S3's -------------------------------

const LOCAL_STORE_DIR =path.join(process.cwd(), ".content-store");
const KEY_PATTERN = /^[a-z0-9][a-z0-9/._-]*$/i;

/** The file on disk for a key, or null when the key could step outside the folder. */
export function localPathFor(key: string): string | null {
  if (!KEY_PATTERN.test(key) || key.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  const full = path.resolve(LOCAL_STORE_DIR, ...key.split("/"));
  return full.startsWith(LOCAL_STORE_DIR + path.sep) ? full : null;
}

type LocalGrant ={ method: "PUT" | "GET"; key: string; exp: number; size: number; type: string; download: string };

function localSecret(): string {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret) throw new Error("AUTH_SECRET is not set.");
  return secret;
}

function signGrant(grant: LocalGrant): string {
  return createHmac("sha256", localSecret())
    .update([grant.method, grant.key, grant.exp, grant.size, grant.type, grant.download].join("\n"))
    .digest("base64url");
}

function localUrl(grant: LocalGrant): string {
  const query = new URLSearchParams({ m: grant.method, exp: String(grant.exp), size: String(grant.size), type: grant.type, dl: grant.download, sig: signGrant(grant) });
  return `/api/content-store/${grant.key.split("/").map(encodeURIComponent).join("/")}?${query}`;
}

/** Reads and checks a signed local address. Null when the signature is wrong or it has expired. */
export function verifyLocalGrant(key: string, params: URLSearchParams, method: "PUT" | "GET", now = Date.now()): LocalGrant | null {
  const grant: LocalGrant = {
    method,
    key,
    exp: Number(params.get("exp")),
    size: Number(params.get("size")),
    type: params.get("type") ?? "",
    download: params.get("dl") ?? "",
  };
  if (params.get("m") !== method || !Number.isFinite(grant.exp) || grant.exp * 1000 < now) return null;
  const given = Buffer.from(params.get("sig") ?? "");
  const expected = Buffer.from(signGrant(grant));
  return given.length === expected.length && timingSafeEqual(given, expected) ? grant : null;
}

// --- What the rest of the app calls --------------------------------------------------------------

/** A short-lived address the creator's browser sends the file to, with the headers it must send. */
export async function presignUpload(key: string, contentType: string, size: number): Promise<{ url: string; headers: Record<string, string> }> {
  const headers = { "Content-Type": contentType };
  if (storageMode() === "s3") {
    const { client, bucket } = s3();
    const url = await getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType, ContentLength: size }), { expiresIn: UPLOAD_SECONDS });
    return { url, headers };
  }
  return { url: localUrl({ method: "PUT", key, exp: Math.floor(Date.now() / 1000) + UPLOAD_SECONDS, size, type: contentType, download: "" }), headers };
}

/** A short-lived address to view the file, or to download it under its original name. Empty when no storage is set up. */
export async function presignView(key: string, contentType: string, download?: string): Promise<string> {
  const mode = storageMode();
  if (!mode) return "";
  // A type outside the list (only possible for rows written before the list existed) is only ever downloaded.
  const allowed = isAllowedType(contentType);
  if (!allowed) download ??= key.split("/").pop() ?? "file";
  contentType = allowed ? contentType : "application/octet-stream";
  const disposition = download ? `attachment; filename="${safeFileName(download)}"` : undefined;
  if (mode === "s3") {
    const { client, bucket } = s3();
    return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentType: contentType, ResponseContentDisposition: disposition }), { expiresIn: VIEW_SECONDS });
  }
  return localUrl({ method: "GET", key, exp: Math.floor(Date.now() / 1000) + VIEW_SECONDS, size: 0, type: contentType, download: download ? safeFileName(download) : "" });
}

/** The stored file's size in bytes, or null when nothing is stored under the key. */
export async function storedSize(key: string): Promise<number | null> {
  if (storageMode() === "s3") {
    const { client, bucket } = s3();
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return head.ContentLength ?? null;
    } catch {
      return null;
    }
  }
  const file = localPathFor(key);
  if (!file) return null;
  try {
    return (await stat(file)).size;
  } catch {
    return null;
  }
}
