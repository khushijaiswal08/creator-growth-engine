import type { ContentStatus, CreatorStatus, Platform, UsageRights } from "@prisma/client";
import { createId } from "@paralleldrive/cuid2";
import { randomBytes } from "node:crypto";
import { automationUserId, refreshNextAction } from "@/lib/automation";
import { classifyFile, MAX_FILE_BYTES, MAX_FILES_PER_UPLOAD, presignUpload, storageKeyFor, storageMode, storedSize } from "@/lib/content-storage";
import { db } from "@/lib/db";
import { appBaseUrl } from "@/lib/selection";
import { CREATOR_STATUS_LABELS } from "@/lib/status";

/** An upload link works for this many days after it is made or last sent, for as many files as the creator likes. */
export const UPLOAD_LINK_DAYS = 60;
const DAY = 24 * 60 * 60 * 1000;

/** What one creator may keep in storage, so a forwarded link cannot fill the bucket. */
export const CREATOR_LIMITS = { files: 200, bytes: 20_000_000_000, pending: 20 };
/** An upload nobody finished within this long is settled by the daily run. */
const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export const USAGE_LABELS: Record<UsageRights, string> = {
  organic: "Our posts only",
  paid: "Our posts and paid ads",
  none: "Not to be reposted",
};

export const CONTENT_STATUS_LABELS: Record<ContentStatus, string> = {
  uploading: "Uploading",
  received: "To review",
  approved: "Approved",
  changes_requested: "Changes asked",
};

/** Statuses where a creator may still send files. Closed-out relationships may not; finished collaborations may. */
const UPLOAD_BLOCKED: ReadonlySet<CreatorStatus> = new Set(["rejected", "not_interested", "blacklisted", "unsubscribed", "bounced", "invalid_contact", "duplicate"]);

/**
 * Statuses that move to "Posts to check" once files arrive: the content came
 * in, so someone should look. A completed collaboration reopens there too, so
 * new files never sit unseen.
 */
const MOVES_TO_POSTED: ReadonlySet<CreatorStatus> = new Set(["product_shipped", "content_expected", "no_content", "completed"]);

export const UPLOAD_LINK_INACTIVE = "This link is no longer active. Please reply to our message and we will send a new one.";

export function uploadLinkExpired(creator: { uploadExpiresAt: Date | null }, now = new Date()): boolean {
  return !creator.uploadExpiresAt || creator.uploadExpiresAt.getTime() <= now.getTime();
}

/** The expiry an upload link gets when it is made, and again each time it is sent. */
export const uploadLinkExpiry = (now = new Date()) => new Date(now.getTime() + UPLOAD_LINK_DAYS * DAY);

/**
 * The creator's private upload link. Like the selection link the token is 192
 * random bits, but it is not spent on use: creators often send files in more
 * than one go, so it stays valid until it expires and is then replaced.
 */
export async function ensureUploadUrl(campaignCreatorId: string, now = new Date()): Promise<string> {
  const existing = await db.campaignCreator.findUnique({ where: { id: campaignCreatorId }, select: { uploadToken: true, uploadExpiresAt: true } });
  let token = existing?.uploadToken ?? null;
  if (!token || !existing || uploadLinkExpired(existing, now)) {
    token = randomBytes(24).toString("base64url");
    await db.campaignCreator.update({ where: { id: campaignCreatorId }, data: { uploadToken: token, uploadExpiresAt: uploadLinkExpiry(now) } });
  }
  return `${await appBaseUrl()}/upload/${token}`;
}

/** The creator behind an upload token, when the link may be used. Everything the public page and actions need. */
export async function loadUploadTarget(token: string, now = new Date()) {
  if (token.length < 20 || token.length > 64) return null;
  const creator = await db.campaignCreator.findUnique({
    where: { uploadToken: token },
    select: {
      id: true,
      status: true,
      influencerId: true,
      uploadExpiresAt: true,
      campaign: { select: { id: true, name: true, brandId: true, status: true } },
      influencer: { select: { name: true, archived: true, profiles: { select: { id: true, platform: true } } } },
      giftOrders: { where: { status: { not: "cancelled" } }, orderBy: { createdAt: "desc" }, take: 1, select: { product: { select: { id: true, title: true, color: true, size: true } } } },
      contentAssets: {
        where: { archived: false, status: { not: "uploading" } },
        orderBy: { createdAt: "desc" },
        take: 50,
        select: { id: true, fileName: true, kind: true, status: true, receivedAt: true },
      },
    },
  });
  if (!creator || creator.influencer.archived || creator.campaign.status === "archived" || UPLOAD_BLOCKED.has(creator.status) || uploadLinkExpired(creator, now)) return null;
  return creator;
}

export type UploadRequest = {
  files: { name: string; type: string; size: number }[];
  usage: string;
  postUrl: string;
  postedOn: string;
  note: string;
};

/** "2026-10-28" from a date field, as midnight UTC; null when empty or not a real date. */
function dayFromField(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function cleanPostUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString().slice(0, 500) : null;
  } catch {
    return null;
  }
}

/**
 * The same post, however it was copied: no tracking query (?igsh=..., ?utm_...)
 * or fragment, no "www.", no trailing slash, lower-case host. Used to tell
 * whether a pasted link is a post the team already recorded.
 */
export function samePostKey(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^(www|m)\./, "");
    // YouTube keeps the video in the query (?v=...); everything else is the path.
    const video = host.endsWith("youtube.com") ? parsed.searchParams.get("v") : null;
    return `${host}${parsed.pathname.replace(/\/+$/, "")}${video ? `?v=${video}` : ""}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Step 1 of an upload: checks what the creator wants to send and records one
 * row per file. Nothing from the caller is trusted beyond the token: sizes
 * and types are checked here, the creator's own limits too, and again when
 * the files land. The addresses to send each file to come one at a time
 * (signUpload), just before that file goes up.
 */
export async function startUpload(token: string, request: UploadRequest, now = new Date()): Promise<{ ok: true; assetIds: string[] } | { ok: false; error: string }> {
  if (!storageMode()) return { ok: false, error: "Uploads are not switched on yet. Please reply to our message with a link to your files instead." };
  const creator = await loadUploadTarget(token, now);
  if (!creator) return { ok: false, error: UPLOAD_LINK_INACTIVE };

  const usage = (["organic", "paid", "none"] as const).find((value) => value === request.usage);
  if (!usage) return { ok: false, error: "Please choose how we may use your content." };
  if (request.files.length === 0) return { ok: false, error: "Please choose at least one video or photo." };
  if (request.files.length > MAX_FILES_PER_UPLOAD) return { ok: false, error: `Please send up to ${MAX_FILES_PER_UPLOAD} files at a time.` };
  const postUrl = request.postUrl.trim() ? cleanPostUrl(request.postUrl) : null;
  if (request.postUrl.trim() && !postUrl) return { ok: false, error: "The post link does not look right. Paste the full address, starting with https://" };

  const files: { name: string; size: number; kind: "video" | "photo" | "other"; contentType: string }[] = [];
  for (const file of request.files) {
    const name = String(file.name ?? "").slice(0, 200) || "file";
    const size = Number(file.size);
    const classified = classifyFile(name, String(file.type ?? ""));
    if (!classified) return { ok: false, error: `"${name}" is not a video or photo. Please send video or photo files only.` };
    if (!Number.isInteger(size) || size <= 0) return { ok: false, error: `"${name}" looks empty.` };
    if (size > MAX_FILE_BYTES) return { ok: false, error: `"${name}" is larger than 2 GB. Please send a smaller export, or reply with a link to it.` };
    files.push({ name, size, ...classified });
  }

  // The creator's own limits, counting files still on their way.
  const [kept, pending] = await Promise.all([
    db.contentAsset.aggregate({ where: { campaignCreatorId: creator.id, archived: false }, _count: { _all: true }, _sum: { sizeBytes: true } }),
    db.contentAsset.count({ where: { campaignCreatorId: creator.id, archived: false, status: "uploading" } }),
  ]);
  const adding = files.reduce((sum, file) => sum + file.size, 0);
  if (pending + files.length > CREATOR_LIMITS.pending) return { ok: false, error: "Some of your earlier files are still on their way. Please wait for them to finish, then send the rest." };
  if (kept._count._all + files.length > CREATOR_LIMITS.files || (kept._sum.sizeBytes ?? 0) + adding > CREATOR_LIMITS.bytes) {
    return { ok: false, error: "That is more than this link can take. Please reply to our message with a link to the rest of your files." };
  }

  const productId = creator.giftOrders[0]?.product?.id ?? null;
  const rows = files.map((file) => {
    const id = createId();
    return {
      id,
      campaignCreatorId: creator.id,
      kind: file.kind,
      fileName: file.name,
      contentType: file.contentType,
      sizeBytes: file.size,
      storageKey: storageKeyFor(creator.campaign.brandId, creator.id, id, file.name),
      usageRights: usage,
      productId,
      postUrl,
      postedAt: dayFromField(request.postedOn),
      creatorNote: request.note.trim().slice(0, 1000) || null,
    };
  });
  await db.contentAsset.createMany({ data: rows });
  return { ok: true, assetIds: rows.map((row) => row.id) };
}

/** Step 2, once per file: a short-lived address to send this one file to, with the headers it must carry. */
export async function signUpload(token: string, assetId: string, now = new Date()): Promise<{ ok: true; url: string; headers: Record<string, string> } | { ok: false; error: string }> {
  const creator = await loadUploadTarget(token, now);
  if (!creator) return { ok: false, error: UPLOAD_LINK_INACTIVE };
  const asset = await db.contentAsset.findFirst({
    where: { id: assetId, campaignCreatorId: creator.id, status: "uploading", archived: false },
    select: { storageKey: true, contentType: true, sizeBytes: true },
  });
  if (!asset) return { ok: false, error: "That file is no longer waiting to be sent. Please choose it again." };
  return { ok: true, ...(await presignUpload(asset.storageKey, asset.contentType, asset.sizeBytes)) };
}

/** The creator's profile a post link belongs to, judged by the address; the first profile when it cannot be told. */
function profileForPost(url: string, profiles: { id: string; platform: Platform }[]): string | null {
  const host = new URL(url).hostname.replace(/^www\./, "");
  const platform: Platform | null = host.endsWith("instagram.com") ? "instagram" : host.endsWith("tiktok.com") ? "tiktok" : host.endsWith("youtube.com") || host === "youtu.be" ? "youtube" : null;
  return profiles.find((profile) => profile.platform === platform)?.id ?? profiles[0]?.id ?? null;
}

type Arrived = { id: string; kind: string; postUrl: string | null; postedAt: Date | null; usageRights: UsageRights };

/**
 * Marks files as received and moves the collaboration on: a post link is
 * recorded once, and a creator still owing content (or finished) goes to
 * "Posts to check" so someone on the team reviews the files. Nothing is
 * approved automatically. Shared by the upload page and the daily run.
 */
async function receive(creatorId: string, arrived: Arrived[], now: Date, how: string): Promise<void> {
  const creator = await db.campaignCreator.findUnique({
    where: { id: creatorId },
    select: { id: true, status: true, influencerId: true, influencer: { select: { profiles: { select: { id: true, platform: true } } } }, posts: { select: { url: true } } },
  });
  if (!creator || arrived.length === 0) return;
  const actor = await automationUserId();
  const postUrl = arrived.find((asset) => asset.postUrl)?.postUrl ?? null;
  const postedAt = arrived.find((asset) => asset.postedAt)?.postedAt ?? null;
  const videos = arrived.filter((asset) => asset.kind === "video").length;
  const photos = arrived.length - videos;
  const what = [videos ? `${videos} ${videos === 1 ? "video" : "videos"}` : null, photos ? `${photos} ${photos === 1 ? "photo" : "photos"}` : null].filter(Boolean).join(" and ");
  const moves = MOVES_TO_POSTED.has(creator.status);
  const knownPosts = new Set(creator.posts.map((post) => samePostKey(post.url)));

  await db.$transaction(async (tx) => {
    // Only rows still uploading change, so two calls for the same file cannot count it twice.
    const marked = await tx.contentAsset.updateMany({ where: { id: { in: arrived.map((asset) => asset.id) }, status: "uploading" }, data: { status: "received", receivedAt: now } });
    if (marked.count === 0) return;
    if (postUrl && !knownPosts.has(samePostKey(postUrl))) {
      const socialProfileId = profileForPost(postUrl, creator.influencer.profiles);
      const taken = await tx.post.findUnique({ where: { url: postUrl }, select: { id: true } });
      if (socialProfileId && !taken) await tx.post.create({ data: { campaignCreatorId: creator.id, socialProfileId, url: postUrl, postedAt } });
    }
    if (moves) {
      await tx.campaignCreator.update({ where: { id: creator.id }, data: { status: "content_posted" } });
      await tx.activity.create({
        data: { userId: actor, automated: true, campaignCreatorId: creator.id, influencerId: creator.influencerId, kind: "status_change", body: `Status changed from ${CREATOR_STATUS_LABELS[creator.status]} to ${CREATOR_STATUS_LABELS.content_posted}: the creator sent their files.` },
      });
    }
    await tx.activity.create({
      data: {
        userId: actor,
        automated: true,
        campaignCreatorId: creator.id,
        influencerId: creator.influencerId,
        kind: "content_received",
        body: `The creator sent ${what} ${how} (usage: ${USAGE_LABELS[arrived[0].usageRights].toLowerCase()})${postUrl ? `, with the post link ${postUrl}` : ""}.`,
      },
    });
  });
  await refreshNextAction(creator.id, now);
}

/**
 * Step 3, once per file as soon as it is sent: the file is checked in storage
 * (it must be there, at the size the creator declared) before it counts.
 * Called file by file, so closing the page halfway loses nothing that arrived.
 */
export async function finishUpload(token: string, assetIds: string[], now = new Date()): Promise<{ ok: true; received: number; missing: number } | { ok: false; error: string }> {
  const creator = await loadUploadTarget(token, now);
  if (!creator) return { ok: false, error: UPLOAD_LINK_INACTIVE };
  const assets = await db.contentAsset.findMany({
    where: { id: { in: assetIds.slice(0, MAX_FILES_PER_UPLOAD) }, campaignCreatorId: creator.id, status: "uploading", archived: false },
    select: { id: true, storageKey: true, sizeBytes: true, kind: true, postUrl: true, postedAt: true, usageRights: true },
  });
  const arrived: Arrived[] = [];
  for (const asset of assets) {
    if ((await storedSize(asset.storageKey)) === asset.sizeBytes) arrived.push(asset);
  }
  if (arrived.length === 0) return { ok: false, error: "We could not find your files. Please try sending them again." };
  await receive(creator.id, arrived, now, "through their upload link");
  return { ok: true, received: arrived.length, missing: assets.length - arrived.length };
}

/**
 * The daily run's tidy-up. A file whose upload was never reported (the page
 * closed, the connection dropped) is checked in storage: if it arrived in
 * full it is received after all; if not, it is archived so it stops counting
 * against the creator's limits. Nothing is deleted.
 */
export async function settleStaleUploads(now = new Date()): Promise<{ received: number; archived: number }> {
  if (!storageMode()) return { received: 0, archived: 0 };
  const stale = await db.contentAsset.findMany({
    where: { status: "uploading", archived: false, createdAt: { lt: new Date(now.getTime() - STALE_AFTER_MS) } },
    take: 500,
    select: { id: true, campaignCreatorId: true, storageKey: true, sizeBytes: true, kind: true, postUrl: true, postedAt: true, usageRights: true },
  });
  const byCreator = new Map<string, Arrived[]>();
  const missing: string[] = [];
  for (const asset of stale) {
    if ((await storedSize(asset.storageKey)) === asset.sizeBytes) byCreator.set(asset.campaignCreatorId, [...(byCreator.get(asset.campaignCreatorId) ?? []), asset]);
    else missing.push(asset.id);
  }
  for (const [creatorId, arrived] of byCreator) await receive(creatorId, arrived, now, "through their upload link (the page closed before it reported back)");
  if (missing.length > 0) await db.contentAsset.updateMany({ where: { id: { in: missing }, status: "uploading" }, data: { archived: true } });
  return { received: [...byCreator.values()].reduce((sum, list) => sum + list.length, 0), archived: missing.length };
}
