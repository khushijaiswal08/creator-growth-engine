import { parseCreatorCsv } from "@/lib/csv";
import type { CreatorSource } from "../types";
import { bareProfile } from "./shared";

/**
 * Candidates come from CSV text in `brief.input`. The import page reads the
 * workflow columns (campaign, status, owner_email) itself through
 * parseCreatorCsv; this adapter exposes the same rows as plain candidates.
 */
export const csvSource: CreatorSource = {
  name: "csv",

  async fetchCandidates(brief) {
    const parsed = parseCreatorCsv(brief.input ?? "");
    if (!parsed.ok) throw new Error(parsed.error);
    const rows = brief.platforms
      ? parsed.rows.filter((row) => brief.platforms!.includes(row.platform))
      : parsed.rows;
    return rows.slice(0, brief.limit).map((row) => ({
      ...bareProfile("csv", row.platform, row.handle),
      name: row.name,
      email: row.email,
      location: row.location,
      followers: row.followers,
    }));
  },

  // A CSV has no remote data to look up.
  async enrichProfile(platform, handle) {
    return bareProfile("csv", platform, handle);
  },
};
