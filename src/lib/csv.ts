import type { CreatorStatus, Platform } from "@prisma/client";
import Papa from "papaparse";
import { normalizeHandle, parsePlatform } from "@/lib/profile-url";
import { parseCreatorStatus } from "@/lib/status";

export const CSV_COLUMNS = [
  "handle",
  "platform",
  "name",
  "email",
  "followers",
  "location",
  "campaign",
  "status",
  "notes",
  "owner_email",
] as const;

export const CSV_REQUIRED_COLUMNS = ["handle", "platform"] as const;

export const CSV_MAX_ROWS = 2000;

export type CsvRow = {
  /** Spreadsheet row number, counting the header as row 1. */
  row: number;
  platform: Platform;
  handle: string;
  name: string | null;
  email: string | null;
  followers: number | null;
  location: string | null;
  campaign: string | null;
  status: CreatorStatus | null;
  notes: string | null;
  ownerEmail: string | null;
  /** Problems with optional cells; the row is still imported. */
  warnings: string[];
};

export type CsvRowError = { row: number; handle: string; platform: string; reason: string };

export type CsvParseResult =
  | { ok: false; error: string }
  | { ok: true; rows: CsvRow[]; errors: CsvRowError[]; ignoredColumns: string[] };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmail(value: string): boolean {
  return EMAIL_RE.test(value);
}

/** "12,500" -> 12500, "12.5k" -> 12500, "1.2M" -> 1200000. */
export function parseFollowers(raw: string): number | null {
  const match = /^([\d.,]+)\s*([km])?$/i.exec(raw.trim());
  if (!match) return null;
  const suffix = match[2]?.toLowerCase();
  const digits = suffix ? match[1].replace(/,/g, "") : match[1].replace(/[.,](?=\d{3}\b)/g, "");
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  const scaled = Math.round(value * (suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1));
  return scaled >= 0 && scaled <= 2_000_000_000 ? scaled : null;
}

function normalizeHeader(header: string): string {
  return header.replace(/^﻿/, "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export function parseCreatorCsv(text: string): CsvParseResult {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: normalizeHeader,
  });

  const headers = parsed.meta.fields ?? [];
  const missing = CSV_REQUIRED_COLUMNS.filter((column) => !headers.includes(column));
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Found: ${headers.join(", ") || "none"}.`,
    };
  }
  if (parsed.data.length > CSV_MAX_ROWS) {
    return {
      ok: false,
      error: `The file has ${parsed.data.length} rows. Import at most ${CSV_MAX_ROWS} rows at a time.`,
    };
  }

  const known = new Set<string>(CSV_COLUMNS);
  const ignoredColumns = headers.filter((header) => header && !known.has(header));

  const rows: CsvRow[] = [];
  const errors: CsvRowError[] = [];

  parsed.data.forEach((record, index) => {
    const row = index + 2;
    const cell = (column: (typeof CSV_COLUMNS)[number]) => (record[column] ?? "").trim();

    const rawHandle = cell("handle");
    const rawPlatform = cell("platform");
    const reject = (reason: string) =>
      errors.push({ row, handle: rawHandle, platform: rawPlatform, reason });

    if (!rawHandle) return reject("Handle is empty.");
    const platform = parsePlatform(rawPlatform);
    if (!platform) return reject(`Unknown platform "${rawPlatform}".`);
    const handle = normalizeHandle(platform, rawHandle);
    if (!handle) return reject(`"${rawHandle}" is not a valid ${platform} handle.`);

    const warnings: string[] = [];

    let email: string | null = cell("email").toLowerCase() || null;
    if (email && !isEmail(email)) {
      warnings.push(`Email "${email}" is not valid and was ignored.`);
      email = null;
    }

    let followers: number | null = null;
    if (cell("followers")) {
      followers = parseFollowers(cell("followers"));
      if (followers === null) {
        warnings.push(`Followers "${cell("followers")}" is not a number and was ignored.`);
      }
    }

    let status: CreatorStatus | null = null;
    if (cell("status")) {
      status = parseCreatorStatus(cell("status"));
      if (!status) warnings.push(`Unknown status "${cell("status")}" was ignored.`);
    }

    let ownerEmail: string | null = cell("owner_email").toLowerCase() || null;
    if (ownerEmail && !isEmail(ownerEmail)) {
      warnings.push(`Owner email "${ownerEmail}" is not valid and was ignored.`);
      ownerEmail = null;
    }

    rows.push({
      row,
      platform,
      handle,
      name: cell("name") || null,
      email,
      followers,
      location: cell("location") || null,
      campaign: cell("campaign") || null,
      status,
      notes: cell("notes") || null,
      ownerEmail,
      warnings,
    });
  });

  return { ok: true, rows, errors, ignoredColumns };
}
