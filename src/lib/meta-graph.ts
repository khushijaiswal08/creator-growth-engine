import { db } from "@/lib/db";

/**
 * A server-side client for Meta's Graph API, used by Instagram Creator
 * Marketplace search. Server-only: the token is read from the environment by
 * the caller and passed in; it travels in the Authorization header and never in
 * a URL, a log line, an error message, the database or anything sent to the
 * browser.
 *
 *   - Each attempt has a timeout; 429, 5xx, Meta's rate-limit codes and network
 *     failures are retried with growing waits, inside a time budget that keeps a
 *     discovery slice short.
 *   - Errors come back as MetaGraphError with a plain-English message: a bad or
 *     expired token (code 190), missing permission, the rate limit, Meta itself
 *     failing, or a request Meta did not accept.
 *   - Every attempt is recorded in ApiCall (service, what was asked, status,
 *     Meta's code, a secret-free message) for Admin › Connected services.
 */

export type MetaErrorKind = "token" | "permission" | "rate_limit" | "server" | "request" | "network";

export class MetaGraphError extends Error {
  constructor(
    readonly kind: MetaErrorKind,
    message: string,
    readonly code: number | null = null,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "MetaGraphError";
  }
}

// Graph error codes: https://developers.facebook.com/docs/graph-api/guides/error-handling (needs verification against the live page).
// Meta's code decides before the HTTP status: Meta sends some rate limits as 400 or 403.
const TOKEN_CODES = new Set([102, 190]);
const RATE_LIMIT_CODES = new Set([4, 17, 32, 341, 613, 80001, 80002]);
const isPermissionCode = (code: number) => code === 3 || code === 10 || (code >= 200 && code <= 299);
/** No new attempt starts unless at least this much of the budget is left for it. */
const MIN_ATTEMPT_MS = 1_500;
/** The Graph API version the Creator Marketplace call was tested with (6 Nov 2026, Graph API Explorer). */
export const DEFAULT_GRAPH_VERSION = "v27.0";

type GraphErrorBody = { error?: { message?: string; code?: number; error_subcode?: number; type?: string } };

/** Removes anything that looks like an access token from text that came back from Meta or a library. */
export function redactSecrets(text: string, ...secrets: (string | undefined | null)[]): string {
  let clean = text;
  for (const secret of secrets) if (secret && secret.length >= 8) clean = clean.split(secret).join("[hidden]");
  return clean
    .replace(/access_token=[^&\s"'<>]+/gi, "access_token=[hidden]")
    .replace(/\bEAA[A-Za-z0-9]{20,}/g, "[hidden token]")
    .replace(/Bearer\s+[A-Za-z0-9._-]{10,}/gi, "Bearer [hidden]")
    .slice(0, 400);
}

export function graphUrl(path: string, params: Record<string, string>): URL {
  if (Object.keys(params).some((name) => name.toLowerCase() === "access_token")) throw new Error("The access token never goes in a URL.");
  const base = (process.env.META_GRAPH_BASE_URL?.trim() || "https://graph.facebook.com").replace(/\/+$/, "");
  const version = process.env.META_GRAPH_VERSION?.trim() || DEFAULT_GRAPH_VERSION;
  const url = new URL(`${base}/${version}/${path.replace(/^\/+/, "")}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url;
}

type CallOptions = {
  /** Integration name for the ApiCall log, e.g. "creator_marketplace". */
  service: string;
  /** What is being asked, in words, for the log and error messages. Never a URL. */
  label: string;
  attempts?: number;
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** The whole call, waits and retries included, ends within this, so a slice stays inside the function limit. */
  budgetMs?: number;
  /** Filled in with the number of requests actually sent, for the run's "API calls" count. */
  counter?: { attempts: number };
};

const retryBaseMs = () => {
  const configured = Number(process.env.META_RETRY_BASE_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : 800;
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function record(service: string, label: string, status: number | null, ok: boolean, errorCode: number | null, error: string | null) {
  try {
    await db.apiCall.create({ data: { service, label, status, ok, errorCode, error }, select: { id: true } });
  } catch {
    // The log is a convenience for the admin screen; a failure to write it must not break the request.
  }
}

function classify(status: number, body: GraphErrorBody, label: string, token: string): MetaGraphError {
  const code = body.error?.code ?? null;
  const said = body.error?.message ? redactSecrets(body.error.message, token) : `HTTP ${status}`;
  const tokenProblem = (shown: number | null) =>
    new MetaGraphError("token", `Meta refused the access token (code ${shown}): it is missing, expired, or not a Page access token. Create a new Page access token and put it in META_ACCESS_TOKEN. Meta said: ${said}`, code, status);
  const permission = (shown: number) =>
    new MetaGraphError("permission", `Meta says this token or app does not have permission for ${label} (code ${shown}). Check the Page token's permissions and the app's access to the Instagram Creator Marketplace. Meta said: ${said}`, code, status);
  const rateLimit = (shown: number) => new MetaGraphError("rate_limit", `Meta's rate limit was reached while asking for ${label} (code ${shown}). What was found so far is kept; try again in an hour.`, code, status);
  if (code !== null) {
    if (TOKEN_CODES.has(code)) return tokenProblem(code);
    if (RATE_LIMIT_CODES.has(code)) return rateLimit(code);
    if (isPermissionCode(code)) return permission(code);
  }
  if (status === 429) return rateLimit(code ?? status);
  if (status === 401) return tokenProblem(code ?? status);
  if (status === 403) return permission(code ?? status);
  if (status >= 500) return new MetaGraphError("server", `Meta did not answer properly for ${label} (HTTP ${status}). Try again later. Meta said: ${said}`, code, status);
  return new MetaGraphError("request", `Meta did not accept the request for ${label} (code ${code ?? status}). Meta said: ${said}`, code, status);
}

/**
 * GET a Graph API path with retries. `params` must not contain the token; it
 * is sent as a Bearer header. Throws MetaGraphError.
 */
export async function metaGraphGet<T>(token: string, path: string, params: Record<string, string>, options: CallOptions): Promise<T> {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const budgetMs = options.budgetMs ?? 9_000;
  const url = graphUrl(path, params);
  const started = Date.now();
  const left = () => budgetMs - (Date.now() - started);
  let last: MetaGraphError | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // Each attempt only gets what is left of the budget, so retries never stretch a slice past it.
    const allowed = Math.max(1, Math.min(timeoutMs, left()));
    if (options.counter) options.counter.attempts += 1;
    let response: Response | null = null;
    let body: unknown = null;
    let unreadable = false;
    try {
      response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(allowed), cache: "no-store" });
      try {
        body = await response.json();
      } catch {
        unreadable = true;
      }
    } catch (error) {
      // The error text is never kept: a fetch error can quote the request headers.
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      response = null;
      last = new MetaGraphError("network", timedOut ? `Meta did not answer in time for ${options.label}.` : `Meta could not be reached for ${options.label}.`);
      await record(options.service, options.label, null, false, null, last.message);
    }
    if (response) {
      if (response.ok && !unreadable) {
        await record(options.service, options.label, response.status, true, null, null);
        return body as T;
      }
      last = response.ok
        ? new MetaGraphError("network", `Meta's answer for ${options.label} could not be read.`, null, response.status)
        : classify(response.status, (unreadable ? {} : body) as GraphErrorBody, options.label, token);
      await record(options.service, options.label, response.status, false, last.code, last.message);
      // A bad token, missing permission or a request Meta does not accept will not get better by asking again.
      if (last.kind !== "rate_limit" && last.kind !== "server" && last.kind !== "network") throw last;
    }
    const retryAfter = response ? Number(response.headers.get("retry-after")) : Number.NaN;
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : retryBaseMs() * 2 ** (attempt - 1);
    // Meta asked for a longer wait than is left, or there is no time for a useful attempt: stop and say so.
    if (attempt < attempts && wait + MIN_ATTEMPT_MS <= left()) {
      await sleep(wait);
      continue;
    }
    break;
  }
  throw last ?? new MetaGraphError("network", `Meta could not be reached for ${options.label}.`);
}
