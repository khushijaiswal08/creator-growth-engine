import type { DataSource, RunStatus } from "@prisma/client";

// The words for discovery sources and runs, kept apart from the database code so the browser can use them too.

export const DISCOVERY_SOURCES = ["youtube", "meta_free"] as const satisfies readonly DataSource[];
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

export const SOURCE_LABELS: Record<DataSource, string> = {
  youtube: "YouTube",
  meta_free: "Instagram hashtags (Meta)",
  vendor: "Data vendor",
  csv: "CSV import",
  manual: "Added by hand",
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  running: "Running",
  completed: "Completed",
  stopped_quota: "Stopped: quota reached",
  not_configured: "Not configured",
  failed: "Failed",
};
