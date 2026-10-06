import { parseProfileUrl } from "@/lib/profile-url";
import type { Candidate, CreatorSource } from "../types";
import { bareProfile } from "./shared";

/** Candidates are profile URLs a person pasted, one per line, in `brief.input`. */
export const manualSource: CreatorSource = {
  name: "manual",

  async fetchCandidates(brief) {
    const candidates: Candidate[] = [];
    const seen = new Set<string>();
    for (const line of (brief.input ?? "").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const parsed = parseProfileUrl(line);
      if (!parsed.ok) continue;
      const { platform, handle } = parsed.profile;
      if (brief.platforms && !brief.platforms.includes(platform)) continue;
      const key = `${platform}:${handle}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(bareProfile("manual", platform, handle));
    }
    return candidates.slice(0, brief.limit);
  },

  // Manual entry knows only what the person typed.
  async enrichProfile(platform, handle) {
    return bareProfile("manual", platform, handle);
  },
};
