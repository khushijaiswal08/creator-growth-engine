import type { DataSource } from "@prisma/client";
import { csvSource } from "./adapters/csv";
import { manualSource } from "./adapters/manual";
import { metaFreeSource } from "./adapters/meta-free";
import { vendorSource } from "./adapters/vendor";
import { youtubeSource } from "./adapters/youtube";
import type { CreatorSource } from "./types";

export { NotImplementedError } from "./errors";
export type { Brief, Candidate, CreatorSource, DiscoveryResult, DiscoveryStatus, ProfileData } from "./types";

const SOURCES: Record<DataSource, CreatorSource> = {
  csv: csvSource,
  manual: manualSource,
  meta_free: metaFreeSource,
  vendor: vendorSource,
  youtube: youtubeSource,
};

const DEFAULT_SOURCE: DataSource = "manual";

/**
 * The single entry point to creator data. With no argument it returns the
 * adapter named by the CREATOR_SOURCE env var. Server-side only.
 */
export function getCreatorSource(name?: DataSource): CreatorSource {
  if (name) return SOURCES[name];
  const configured = process.env.CREATOR_SOURCE?.trim() || DEFAULT_SOURCE;
  if (!(configured in SOURCES)) {
    throw new Error(
      `CREATOR_SOURCE="${configured}" is not a known creator source. Use one of: ${Object.keys(SOURCES).join(", ")}.`,
    );
  }
  return SOURCES[configured as DataSource];
}
