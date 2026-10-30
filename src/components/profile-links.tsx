import type { Platform } from "@prisma/client";
import { formatCount } from "@/lib/format";
import { displayHandle, PLATFORM_LABELS, profileUrl } from "@/lib/profile-url";

const PLATFORM_SHORT: Record<Platform, string> = { instagram: "IG", tiktok: "TT", youtube: "YT" };

/**
 * Compact one-line-per-profile list for table cells. `inline` puts the
 * handles on one small line (no follower counts), for under a name.
 */
export function ProfileLinks({
  profiles,
  inline = false,
}: {
  profiles: { id: string; platform: Platform; handle: string; followers: number | null }[];
  inline?: boolean;
}) {
  if (profiles.length === 0) return inline ? null : <span className="text-muted-foreground">None</span>;

  if (inline) {
    return (
      <span className="flex flex-wrap gap-x-2 text-xs font-medium">
        {profiles.map((profile) => (
          <a key={profile.id} href={profileUrl(profile.platform, profile.handle)} target="_blank" rel="noopener noreferrer" className="link" title={PLATFORM_LABELS[profile.platform]}>
            <span className="font-semibold text-muted-foreground">{PLATFORM_SHORT[profile.platform]}</span> {displayHandle(profile.handle)}
          </a>
        ))}
      </span>
    );
  }

  return (
    <ul className="grid gap-0.5">
      {profiles.map((profile) => (
        <li key={profile.id} className="flex items-baseline gap-1.5">
          <abbr
            title={PLATFORM_LABELS[profile.platform]}
            className="w-5 text-xs font-semibold text-muted-foreground no-underline"
          >
            {PLATFORM_SHORT[profile.platform]}
          </abbr>
          <a
            href={profileUrl(profile.platform, profile.handle)}
            target="_blank"
            rel="noopener noreferrer"
            className="link"
          >
            {displayHandle(profile.handle)}
          </a>
          {profile.followers !== null ? (
            <span className="text-xs text-muted-foreground tabular-nums">{formatCount(profile.followers)}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
