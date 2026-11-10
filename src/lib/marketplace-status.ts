import { db } from "@/lib/db";
import { marketplaceConfigured, marketplaceFields, missingMarketplaceSettings } from "@/lib/fetching/adapters/creator-marketplace";
import { redactSecrets } from "@/lib/meta-graph";

const SERVICE = "creator_marketplace";
const HOUR_MS = 60 * 60 * 1000;

export type MarketplaceStatus = {
  configured: boolean;
  /** The empty server settings, by name. */
  missing: string[];
  fields: string[];
  lastRun: { at: Date; status: string; campaign: string } | null;
  /** The newest failed request or failed run, whichever is later. Secret-free. */
  lastError: { at: Date; message: string } | null;
  requestsLastHour: number;
};

/** What Admin › Connected services shows for the Instagram Creator Marketplace. Never reads or returns the token. */
export async function marketplaceStatus(now = new Date()): Promise<MarketplaceStatus> {
  const [lastRun, lastFailedRun, lastFailedCall, requestsLastHour] = await Promise.all([
    db.discoveryRun.findFirst({ where: { source: "meta_marketplace" }, orderBy: { startedAt: "desc" }, select: { startedAt: true, status: true, campaign: { select: { name: true } } } }),
    // A run fails in whichever slice meets the problem, so it is dated by when it finished.
    db.discoveryRun.findFirst({ where: { source: "meta_marketplace", status: { in: ["failed", "stopped_quota", "not_configured"] }, note: { not: null }, finishedAt: { not: null } }, orderBy: { finishedAt: "desc" }, select: { finishedAt: true, note: true } }),
    db.apiCall.findFirst({ where: { service: SERVICE, ok: false }, orderBy: { createdAt: "desc" }, select: { createdAt: true, error: true } }),
    db.apiCall.count({ where: { service: SERVICE, createdAt: { gt: new Date(now.getTime() - HOUR_MS) } } }),
  ]);
  const errors = [
    lastFailedRun?.note && lastFailedRun.finishedAt ? { at: lastFailedRun.finishedAt, message: lastFailedRun.note } : null,
    lastFailedCall?.error ? { at: lastFailedCall.createdAt, message: lastFailedCall.error } : null,
  ].filter((entry): entry is { at: Date; message: string } => entry !== null);
  const newest = errors.sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;
  return {
    configured: marketplaceConfigured(),
    missing: missingMarketplaceSettings(),
    fields: marketplaceFields(),
    lastRun: lastRun ? { at: lastRun.startedAt, status: lastRun.status, campaign: lastRun.campaign.name } : null,
    // Stored messages are already secret-free; redacting again costs nothing and guards against an older row.
    lastError: newest ? { at: newest.at, message: redactSecrets(newest.message, process.env.META_ACCESS_TOKEN?.trim()) } : null,
    requestsLastHour,
  };
}
