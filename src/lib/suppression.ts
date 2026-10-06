import type { Platform } from "@prisma/client";
import { db } from "@/lib/db";

type Target = {
  email: string | null;
  profiles: { platform: Platform; handle: string }[];
};

export type SuppressionIndex = {
  /** Returns the suppression reason, or null when the target may be contacted. */
  reasonFor(target: Target): string | null;
};

/**
 * Loads the suppression rows relevant to a set of targets in one query.
 * Must be consulted before any send. Emails are stored lowercase.
 */
export async function loadSuppressions(targets: Target[]): Promise<SuppressionIndex> {
  const emails = [
    ...new Set(targets.flatMap((t) => (t.email ? [t.email.toLowerCase()] : []))),
  ];
  const handles = [...new Set(targets.flatMap((t) => t.profiles.map((p) => p.handle)))];

  const byEmail = new Map<string, string>();
  const byProfile = new Map<string, string>();

  if (emails.length > 0 || handles.length > 0) {
    const rows = await db.suppression.findMany({
      where: { OR: [{ email: { in: emails } }, { handle: { in: handles } }] },
    });
    for (const row of rows) {
      if (row.email) byEmail.set(row.email.toLowerCase(), row.reason);
      if (row.platform && row.handle) byProfile.set(`${row.platform}:${row.handle}`, row.reason);
    }
  }

  return {
    reasonFor(target) {
      if (target.email) {
        const reason = byEmail.get(target.email.toLowerCase());
        if (reason) return reason;
      }
      for (const profile of target.profiles) {
        const reason = byProfile.get(`${profile.platform}:${profile.handle}`);
        if (reason) return reason;
      }
      return null;
    },
  };
}
