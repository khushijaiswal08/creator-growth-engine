import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isAllowedType, localPathFor, storageMode, verifyLocalGrant } from "@/lib/content-storage";

export const dynamic = "force-dynamic";

/**
 * The test copy's stand-in for object storage: the signed upload and view
 * addresses from src/lib/content-storage.ts land here. It answers 404 unless
 * local storage is in use, which is never the case in production.
 */
async function target(params: Promise<{ key: string[] }>, request: Request, method: "PUT" | "GET") {
  if (storageMode() !== "local") return null;
  const key = (await params).key.map(decodeURIComponent).join("/");
  const grant = verifyLocalGrant(key, new URL(request.url).searchParams, method);
  const file = grant ? localPathFor(key) : null;
  return grant && file ? { grant, file } : null;
}

const notFound = () => new Response("Not found", { status: 404 });

export async function PUT(request: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const found = await target(params, request, "PUT");
  if (!found || !request.body) return notFound();
  const { grant, file } = found;
  if ((request.headers.get("content-type") ?? "") !== grant.type || !isAllowedType(grant.type)) return new Response("Wrong content type", { status: 400 });
  // An arrived file is never replaced: a reused upload address cannot swap the bytes behind an approved file.
  if (await stat(file).then(() => true, () => false)) return new Response("Already uploaded", { status: 409 });

  // Never take more bytes than the creator said the file has.
  let received = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      received += chunk.length;
      done(received > grant.size ? new Error("too large") : null, chunk);
    },
  });
  await mkdir(path.dirname(file), { recursive: true });
  const partial = `${file}.part`;
  try {
    await pipeline(Readable.fromWeb(request.body as import("node:stream/web").ReadableStream), limit, createWriteStream(partial));
    await rename(partial, file);
  } catch {
    await rm(partial, { force: true });
    return new Response("Upload failed", { status: 400 });
  }
  return new Response(null, { status: 200, headers: { ETag: `"${received}"` } });
}

export async function GET(request: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const found = await target(params, request, "GET");
  if (!found) return notFound();
  const { grant, file } = found;
  let size: number;
  try {
    size = (await stat(file)).size;
  } catch {
    return notFound();
  }
  // Files are shown, never run: a fixed type list, no sniffing, and a sandbox in case anything slips through.
  const allowed = isAllowedType(grant.type);
  const headers: Record<string, string> = {
    "Content-Type": allowed ? grant.type : "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=600",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
  };
  if (grant.download || !allowed) headers["Content-Disposition"] = `attachment; filename="${grant.download || "file"}"`;

  // Videos seek with range requests.
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (range && size > 0) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const stream = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
    return new Response(stream, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
  }
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers: { ...headers, "Content-Length": String(size) } });
}
