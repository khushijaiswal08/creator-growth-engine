import { NotImplementedError } from "../errors";
import type { CreatorSource } from "../types";

/** Stub for a paid creator-data vendor. Keys, when added, are read from server-side env only. */
export const vendorSource: CreatorSource = {
  name: "vendor",

  async fetchCandidates() {
    throw new NotImplementedError("vendor", "fetchCandidates");
  },

  async enrichProfile() {
    throw new NotImplementedError("vendor", "enrichProfile");
  },
};
