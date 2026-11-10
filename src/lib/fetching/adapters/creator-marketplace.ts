import { metaGraphGet, MetaGraphError } from "@/lib/meta-graph";
import { normalizeHandle } from "@/lib/profile-url";
import type { Brief, Candidate, CreatorSource, DiscoveryResult, DiscoveryStep } from "../types";
import { bareProfile, clip, emailInText, matchesNegative } from "./shared";

/**
 * Instagram Creator Marketplace search (Meta "Route A"):
 *
 *   GET /{IG_BUSINESS_ID}/creator_marketplace_creators
 *
 * Needs a Facebook PAGE access token in META_ACCESS_TOKEN (a user token is
 * refused with code 190) and the Instagram business account id in
 * IG_BUSINESS_ID, both server-side only. Tested 6 Nov 2026 in Graph API
 * Explorer (v27.0): with ?limit=5 it returned creator ids only, plus
 * paging.cursors and a paging.next URL. That URL carries the token in its query
 * string, so it is never followed, stored or shown: pages are read with the
 * "after" cursor instead.
 *
 * What a creator object can offer is not known yet. MARKETPLACE_FIELDS is the
 * one place to list the fields to ask for, once Admin › Connected services ›
 * "Check available fields" has shown their names. Until then Meta returns ids
 * only, and a creator without a username cannot become a creator in the portal
 * (there is no handle to dedupe on): the run counts them and says so.
 *
 * Filtering by the campaign's keywords is not confirmed for this endpoint.
 * MARKETPLACE_KEYWORD_PARAM names the query parameter once Meta's docs confirm
 * one; until then no filter is sent, runs read the first MAX_PAGES pages, and
 * the Discovery tab says that results are not filtered by keywords.
 *
 * Results then go through the normal discovery path: duplicate check against
 * the portal's creators and the do-not-contact list, status Discovered, AI fit
 * scoring, and a person's decision in the Review queue.
 */

/** The creator fields to request. Fill in from "Check available fields". META_MARKETPLACE_FIELDS (comma separated) overrides it without a code change. */
export const MARKETPLACE_FIELDS: readonly string[] = [];
/** The query parameter that filters creators by keyword, once Meta's documentation confirms one. Null: no filter is sent. */
export const MARKETPLACE_KEYWORD_PARAM: string | null = null;

const PAGE_SIZE = 25;
const MAX_PAGES = 4;
const SERVICE = "creator_marketplace";

/** The fields this deployment asks Meta for: the env override when set, else MARKETPLACE_FIELDS. */
export function marketplaceFields(): string[] {
  const override = process.env.META_MARKETPLACE_FIELDS?.trim();
  const list = override ? override.split(",") : [...MARKETPLACE_FIELDS];
  return [...new Set(list.map((field) => field.trim()).filter((field) => /^[a-z0-9_]+$/i.test(field)))];
}

const credentials = () => ({ token: process.env.META_ACCESS_TOKEN?.trim() || null, businessId: process.env.IG_BUSINESS_ID?.trim() || null });

/** True when both server settings are present (says nothing about whether Meta accepts the token). */
export function marketplaceConfigured(): boolean {
  const { token, businessId } = credentials();
  return Boolean(token && businessId);
}

/** The server settings that are empty, by name (never their values). */
export function missingMarketplaceSettings(): string[] {
  const { token, businessId } = credentials();
  return [!token && "META_ACCESS_TOKEN", !businessId && "IG_BUSINESS_ID"].filter((name): name is string => Boolean(name));
}

function missingSettings(): string | null {
  const missing = missingMarketplaceSettings();
  return missing.length > 0 ? `Instagram Creator Marketplace is not configured: ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} missing.` : null;
}

type MarketplaceCreator = Record<string, unknown> & { id?: string };
type MarketplacePage = { data?: MarketplaceCreator[]; paging?: { cursors?: { before?: string; after?: string }; next?: string } };

export type MarketplaceReport = {
  pages: number;
  creatorsSeen: number;
  /** Creators Meta returned without a username: they cannot be added until a username field is requested. */
  withoutUsername: number;
  /** A few of their Meta ids, to look up by hand if needed. */
  sampleIdsWithoutUsername: string[];
  fieldsRequested: string[];
  /** Field names Meta actually returned (names only, never values). */
  fieldsReturned: string[];
  keywordFilter: string | null;
  moreAvailable: boolean;
};

type Cursor = { phase: "pages"; after: string | null; page: number; report: MarketplaceReport };

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
const count = (value: unknown): number | null => {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
};
const first = (creator: MarketplaceCreator, names: string[]) => names.map((name) => creator[name]).find((value) => value !== undefined && value !== null);

/** A portal candidate from one marketplace creator, or null when Meta did not say who it is. */
function candidateFrom(creator: MarketplaceCreator): Candidate | null {
  const username = text(first(creator, ["username", "ig_username", "instagram_username", "handle"]));
  const handle = username ? normalizeHandle("instagram", username) : null;
  if (!handle) return null;
  const bio = text(first(creator, ["biography", "bio", "description"]));
  return {
    ...bareProfile("meta_marketplace", "instagram", handle),
    name: text(first(creator, ["name", "full_name", "display_name"])),
    bio: bio ? clip(bio, 1000) : null,
    email: emailInText(bio),
    website: text(first(creator, ["website"])),
    followers: count(first(creator, ["followers_count", "follower_count", "followers"])),
    country: text(first(creator, ["country", "country_code"])),
    fetchedAt: new Date(),
  };
}

const finished = (status: DiscoveryStep["status"], note: string | null, extra: Partial<DiscoveryStep> = {}): DiscoveryStep => ({
  candidates: [],
  status,
  quotaUsed: 0,
  skipped: 0,
  note,
  cursor: null,
  done: true,
  ...extra,
});

function emptyReport(fields: string[], keywordFilter: string | null): MarketplaceReport {
  return { pages: 0, creatorsSeen: 0, withoutUsername: 0, sampleIdsWithoutUsername: [], fieldsRequested: fields, fieldsReturned: [], keywordFilter, moreAvailable: false };
}

/** One page of creators per slice, MAX_PAGES pages a run at most. */
async function discoverStep(brief: Brief, cursor: Record<string, unknown> | null): Promise<DiscoveryStep> {
  const notConfigured = missingSettings();
  if (notConfigured) return finished("not_configured", notConfigured);
  const { token, businessId } = credentials() as { token: string; businessId: string };

  const fields = marketplaceFields();
  const keywords = (brief.nicheKeywords ?? []).filter(Boolean);
  const keywordFilter = MARKETPLACE_KEYWORD_PARAM && keywords.length > 0 ? keywords.join(",") : null;
  const state: Cursor = cursor && (cursor as Cursor).phase === "pages" ? (cursor as Cursor) : { phase: "pages", after: null, page: 0, report: emptyReport(fields, keywordFilter) };
  const report = state.report;
  const params: Record<string, string> = { limit: String(PAGE_SIZE) };
  if (fields.length > 0) params.fields = ["id", ...fields.filter((field) => field !== "id")].join(",");
  if (state.after) params.after = state.after;
  if (MARKETPLACE_KEYWORD_PARAM && keywordFilter) params[MARKETPLACE_KEYWORD_PARAM] = keywordFilter;

  // Counts every request sent, retries included, so "API calls" matches what Meta received.
  const counter = { attempts: 0 };
  let page: MarketplacePage;
  try {
    page = await metaGraphGet<MarketplacePage>(token, `${businessId}/creator_marketplace_creators`, params, { service: SERVICE, label: "the creator marketplace list", counter });
  } catch (error) {
    const quotaUsed = counter.attempts;
    if (error instanceof MetaGraphError && error.kind === "rate_limit") return finished("stopped_quota", error.message, { report, quotaUsed });
    return finished("failed", error instanceof MetaGraphError ? error.message : "Instagram Creator Marketplace search failed.", { report, quotaUsed });
  }

  const negatives = (brief.negativeKeywords ?? []).filter(Boolean);
  const candidates: Candidate[] = [];
  let skipped = 0;
  const returned = new Set(report.fieldsReturned);
  for (const creator of page.data ?? []) {
    report.creatorsSeen += 1;
    for (const name of Object.keys(creator)) returned.add(name);
    const candidate = candidateFrom(creator);
    if (!candidate) {
      report.withoutUsername += 1;
      if (creator.id && report.sampleIdsWithoutUsername.length < 5) report.sampleIdsWithoutUsername.push(String(creator.id));
      continue;
    }
    if (matchesNegative(`${candidate.name ?? ""} ${candidate.bio ?? ""}`, negatives)) {
      skipped += 1;
      continue;
    }
    candidates.push(candidate);
  }
  report.fieldsReturned = [...returned].sort();
  report.pages += 1;

  // Only the cursor is kept: paging.next carries the token and is dropped here.
  const after = page.paging?.next ? (page.paging.cursors?.after ?? null) : null;
  report.moreAvailable = Boolean(after);
  const limitReached = brief.limit !== undefined && report.creatorsSeen >= brief.limit;
  const done = !after || report.pages >= MAX_PAGES || limitReached;

  const notes: string[] = [];
  if (done && report.withoutUsername > 0) {
    notes.push(
      fields.length === 0
        ? `Meta returned ${report.withoutUsername} creators as ids only. Use "Check available fields" in Admin › Connected services, then add the username field to MARKETPLACE_FIELDS so they can be added.`
        : `${report.withoutUsername} creators came back without a username and were not added.`,
    );
  }
  if (done && !keywordFilter) notes.push(`Not filtered by the campaign's keywords (Meta's filter for this list is not confirmed); ${report.pages} ${report.pages === 1 ? "page" : "pages"} read. AI fit scoring sorts them against the brief.`);
  if (done && report.moreAvailable) notes.push(`Meta has more creators; a run reads ${MAX_PAGES * PAGE_SIZE} at most.`);

  return {
    candidates,
    status: "completed",
    quotaUsed: counter.attempts,
    skipped,
    note: notes.join(" ") || null,
    report,
    cursor: done ? null : { phase: "pages", after, page: state.page + 1, report } satisfies Cursor,
    done,
  };
}

/** The whole run in one call, for scripts. The screen and the job tick use discoverStep. */
async function discover(brief: Brief): Promise<DiscoveryResult> {
  const candidates: Candidate[] = [];
  let cursor: Record<string, unknown> | null = null;
  let quotaUsed = 0;
  let skipped = 0;
  let status: DiscoveryResult["status"] = "completed";
  const notes: string[] = [];
  let report: DiscoveryResult["report"];
  for (;;) {
    const step = await discoverStep(brief, cursor);
    candidates.push(...step.candidates);
    quotaUsed += step.quotaUsed;
    skipped += step.skipped;
    if (step.status !== "completed") status = step.status;
    if (step.note) notes.push(step.note);
    report = step.report ?? report;
    cursor = step.cursor;
    if (step.done) break;
  }
  return { candidates, status, quotaUsed, skipped, note: notes.join(" ") || null, report };
}

export type FieldCheck = { ok: true; fields: string[]; creatorId: string } | { ok: false; error: string };

/**
 * Admin only (checked by the caller): asks Meta once which fields a creator
 * object has, by reading one creator id from the list and then
 * GET /{creator-id}?metadata=1. Returns field names only, never values.
 */
export async function checkMarketplaceFields(): Promise<FieldCheck> {
  const notConfigured = missingSettings();
  if (notConfigured) return { ok: false, error: notConfigured };
  const { token, businessId } = credentials() as { token: string; businessId: string };
  try {
    const page = await metaGraphGet<MarketplacePage>(token, `${businessId}/creator_marketplace_creators`, { limit: "1" }, { service: SERVICE, label: "one creator id" });
    const creatorId = page.data?.[0]?.id ? String(page.data[0].id) : null;
    if (!creatorId) return { ok: false, error: "Meta returned no creators, so there was no creator to describe." };
    const described = await metaGraphGet<{ metadata?: { fields?: { name?: string }[] } }>(token, encodeURIComponent(creatorId), { metadata: "1" }, { service: SERVICE, label: "the creator fields" });
    const fields = [...new Set((described.metadata?.fields ?? []).flatMap((field) => (typeof field.name === "string" && /^[a-z0-9_]+$/i.test(field.name) ? [field.name] : [])))].sort();
    if (fields.length === 0) return { ok: false, error: "Meta answered but did not list any fields for a creator." };
    return { ok: true, fields, creatorId };
  } catch (error) {
    return { ok: false, error: error instanceof MetaGraphError ? error.message : "The field check failed." };
  }
}

export const creatorMarketplaceSource: CreatorSource = {
  name: "meta_marketplace",
  discover,
  discoverStep,

  async fetchCandidates(brief) {
    const result = await discover(brief);
    if (result.status === "not_configured" || result.status === "failed") throw new Error(result.note ?? "Instagram Creator Marketplace search failed.");
    return result.candidates;
  },

  async enrichProfile(platform, handle) {
    return bareProfile("meta_marketplace", platform, handle);
  },
};
