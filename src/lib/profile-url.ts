import type { Platform } from "@prisma/client";

export const PLATFORM_LABELS: Record<Platform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
};

export const PLATFORMS = Object.keys(PLATFORM_LABELS) as Platform[];

const PLATFORM_ALIASES: Record<string, Platform> = {
  instagram: "instagram",
  insta: "instagram",
  ig: "instagram",
  tiktok: "tiktok",
  "tik tok": "tiktok",
  tt: "tiktok",
  youtube: "youtube",
  yt: "youtube",
};

export function parsePlatform(raw: string): Platform | null {
  return PLATFORM_ALIASES[raw.trim().toLowerCase()] ?? null;
}

export type ParsedProfile = { platform: Platform; handle: string };
export type ParseResult =
  | { ok: true; profile: ParsedProfile }
  | { ok: false; error: string };

const HANDLE_RE = /^[a-z0-9._-]{1,60}$/;
const YOUTUBE_PATH_RE = /^(channel|c|user)\/([A-Za-z0-9._-]{1,80})$/i;

const NOT_A_PROFILE =
  "This looks like a post or page link, not a profile. Paste the creator's profile URL.";

// Instagram paths that are never a username.
const INSTAGRAM_RESERVED = new Set([
  "p",
  "reel",
  "reels",
  "tv",
  "explore",
  "accounts",
  "direct",
  "about",
  "developer",
  "legal",
]);

function cleanHandle(platform: Platform, raw: string): string | null {
  const stripped = raw.trim().replace(/^@+/, "").replace(/\/+$/, "");

  // Legacy YouTube URLs have no @handle. Keep the path so the profile URL can
  // be rebuilt; channel ids are case-sensitive.
  const youtubePath = platform === "youtube" ? YOUTUBE_PATH_RE.exec(stripped) : null;
  if (youtubePath) {
    const kind = youtubePath[1].toLowerCase();
    const id = kind === "channel" ? youtubePath[2] : youtubePath[2].toLowerCase();
    return `${kind}/${id}`;
  }

  const handle = stripped.toLowerCase();
  return HANDLE_RE.test(handle) ? handle : null;
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^[\w.-]+\.(com|me|am)\//i.test(value);
}

function fail(error: string): ParseResult {
  return { ok: false, error };
}

export function parseProfileUrl(input: string): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) return fail("Paste a profile URL.");

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return fail("That is not a valid URL.");
  }

  const host = url.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
  const segments = url.pathname.split("/").filter(Boolean);
  const first = segments[0] ?? "";

  let platform: Platform;
  let raw: string;

  if (host === "instagram.com" || host === "instagr.am") {
    platform = "instagram";
    if (first.toLowerCase() === "stories") raw = segments[1] ?? "";
    else if (INSTAGRAM_RESERVED.has(first.toLowerCase())) return fail(NOT_A_PROFILE);
    else raw = first;
  } else if (host === "ig.me") {
    platform = "instagram";
    raw = first.toLowerCase() === "m" ? (segments[1] ?? "") : "";
  } else if (host === "tiktok.com") {
    platform = "tiktok";
    if (!first.startsWith("@")) return fail(NOT_A_PROFILE);
    raw = first;
  } else if (host === "vm.tiktok.com" || host === "vt.tiktok.com") {
    return fail("This is a TikTok short link. Open it and paste the profile URL instead.");
  } else if (host === "youtube.com") {
    platform = "youtube";
    if (first.startsWith("@")) raw = first;
    else if (/^(channel|c|user)$/i.test(first) && segments[1]) raw = `${first}/${segments[1]}`;
    else return fail(NOT_A_PROFILE);
  } else if (host === "youtu.be") {
    return fail(NOT_A_PROFILE);
  } else {
    return fail("Only Instagram, TikTok and YouTube profile URLs are supported.");
  }

  const handle = cleanHandle(platform, raw);
  if (!handle) return fail("Could not read a handle from that URL.");
  return { ok: true, profile: { platform, handle } };
}

/** Normalise a handle typed or pasted into a field. Accepts "@name", "name" or a profile URL. */
export function normalizeHandle(platform: Platform, raw: string): string | null {
  if (looksLikeUrl(raw.trim())) {
    const parsed = parseProfileUrl(raw);
    return parsed.ok && parsed.profile.platform === platform ? parsed.profile.handle : null;
  }
  return cleanHandle(platform, raw);
}

export function profileUrl(platform: Platform, handle: string): string {
  switch (platform) {
    case "instagram":
      return `https://www.instagram.com/${handle}/`;
    case "tiktok":
      return `https://www.tiktok.com/@${handle}`;
    case "youtube":
      return handle.includes("/")
        ? `https://www.youtube.com/${handle}`
        : `https://www.youtube.com/@${handle}`;
  }
}

/** Where the Message button sends the user: the Instagram DM composer, or the profile elsewhere. */
export function messageUrl(platform: Platform, handle: string): string {
  return platform === "instagram" ? `https://ig.me/m/${handle}` : profileUrl(platform, handle);
}

export function displayHandle(handle: string): string {
  return handle.includes("/") ? handle : `@${handle}`;
}
