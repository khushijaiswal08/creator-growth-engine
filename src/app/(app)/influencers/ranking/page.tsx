import type { Metadata } from "next";
import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { EmptyRow, PageHeader } from "@/components/panel";
import { ProfileLinks } from "@/components/profile-links";
import { Pill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { viewed } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import { formatCount, formatDay } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { describeTrackRecord, trackRecordFor } from "@/lib/track-record";

export const metadata: Metadata = { title: "Creator ranking" };

const PAGE_SIZE = 100;

const SORTS = {
  posts: "Most content delivered",
  rate: "Best content rate",
  gmv: "Highest Amazon sales",
  followers: "Most followers",
  engagement: "Highest engagement",
  recent: "Most recent collaboration",
} as const;
type SortKey = keyof typeof SORTS;

const WORKED = { any: "Everyone", yes: "Worked with before", no: "Never gifted" } as const;
type WorkedKey = keyof typeof WORKED;

const TIER_ORDER = ["platinum", "gold", "silver", "bronze", "entry"];

/**
 * Every creator in view, ranked. The figures come from what the portal has
 * recorded (gifts, posts, follow-ups) and from Amazon Creator Connections
 * where the creator is in that programme. Attributed sales from Amazon
 * Attribution join this table once those reports are imported.
 */
export default async function RankingPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; worked?: string; us?: string; tier?: string; min?: string; q?: string; page?: string }>;
}) {
  const view = viewed(await requireUser());
  const params = await searchParams;
  const sort: SortKey = (Object.keys(SORTS) as SortKey[]).includes(params.sort as SortKey) ? (params.sort as SortKey) : "posts";
  const worked: WorkedKey = (Object.keys(WORKED) as WorkedKey[]).includes(params.worked as WorkedKey) ? (params.worked as WorkedKey) : "any";
  const usOnly = params.us === "1";
  const tier = (params.tier ?? "").toLowerCase();
  const minFollowers = Math.max(0, Number.parseInt(params.min ?? "0", 10) || 0);
  const q = (params.q ?? "").trim().toLowerCase();
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  const influencers = await db.influencer.findMany({
    where: { ...view.influencers, archived: false },
    select: {
      id: true,
      name: true,
      location: true,
      usSignal: true,
      amazonTier: true,
      amazonMonthlyGmvUsd: true,
      profiles: { select: { id: true, platform: true, handle: true, followers: true, engagementRate: true, country: true, bio: true }, orderBy: { platform: "asc" } },
      campaigns: {
        where: view.creators,
        select: { status: true, lastContactedAt: true, posts: { select: { createdAt: true }, orderBy: { createdAt: "desc" }, take: 1 }, giftOrders: { where: { status: { not: "cancelled" } }, select: { shippedAt: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 1 } },
      },
    },
  });
  const records = await trackRecordFor(influencers.map((row) => row.id), view);

  const rows = influencers
    .map((row) => {
      const record = records.get(row.id);
      const followers = Math.max(0, ...row.profiles.map((profile) => profile.followers ?? 0));
      const engagement = Math.max(0, ...row.profiles.map((profile) => profile.engagementRate ?? 0));
      const finished = (record?.delivered ?? 0) + (record?.noContent ?? 0);
      const lastPost = row.campaigns.flatMap((link) => link.posts.map((post) => post.createdAt)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      const lastGift = row.campaigns.flatMap((link) => link.giftOrders.map((gift) => gift.shippedAt ?? gift.createdAt)).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      const us = row.usSignal !== null ? row.usSignal >= 60 : row.profiles.some((profile) => profile.country === "US") || /united states|\bUS\b|USA/i.test(row.location ?? "");
      return {
        id: row.id,
        name: row.name,
        location: row.location,
        profiles: row.profiles,
        followers,
        engagement,
        gifts: record?.gifts ?? 0,
        posts: record?.posts ?? 0,
        rate: finished > 0 ? Math.round(((record?.delivered ?? 0) / finished) * 100) : null,
        record: describeTrackRecord(record),
        tier: row.amazonTier,
        gmv: row.amazonMonthlyGmvUsd === null ? null : Number(row.amazonMonthlyGmvUsd),
        lastCollaboration: [lastPost, lastGift].filter((date): date is Date => date !== null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
        us,
      };
    })
    .filter((row) => (worked === "yes" ? row.gifts > 0 : worked === "no" ? row.gifts === 0 : true))
    .filter((row) => (usOnly ? row.us : true))
    .filter((row) => (tier ? (row.tier ?? "").toLowerCase() === tier : true))
    .filter((row) => row.followers >= minFollowers)
    .filter((row) => (q ? row.name.toLowerCase().includes(q) || row.profiles.some((profile) => profile.handle.includes(q) || (profile.bio ?? "").toLowerCase().includes(q)) : true));

  const tierRank = (value: string | null) => (value ? TIER_ORDER.indexOf(value.toLowerCase()) : TIER_ORDER.length);
  rows.sort((a, b) => {
    switch (sort) {
      case "rate":
        return (b.rate ?? -1) - (a.rate ?? -1) || b.posts - a.posts;
      case "gmv":
        return (b.gmv ?? -1) - (a.gmv ?? -1) || tierRank(a.tier) - tierRank(b.tier);
      case "followers":
        return b.followers - a.followers;
      case "engagement":
        return b.engagement - a.engagement;
      case "recent":
        return (b.lastCollaboration?.getTime() ?? 0) - (a.lastCollaboration?.getTime() ?? 0);
      default:
        return b.posts - a.posts || (b.rate ?? -1) - (a.rate ?? -1) || b.followers - a.followers;
    }
  });

  const lastPage = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const href = (overrides: Record<string, string | undefined>) => {
    const query = new URLSearchParams();
    const merged = { sort, worked, us: usOnly ? "1" : undefined, tier: tier || undefined, min: minFollowers ? String(minFollowers) : undefined, q: q || undefined, ...overrides };
    for (const [key, value] of Object.entries(merged)) if (value) query.set(key, value);
    const text = query.toString();
    return text ? `/influencers/ranking?${text}` : "/influencers/ranking";
  };
  const tiers = [...new Set(influencers.map((row) => row.amazonTier?.toLowerCase()).filter((value): value is string => Boolean(value)))].sort((a, b) => tierRank(a) - tierRank(b));

  return (
    <>
      <PageHeader title="Creator ranking" meta={`${rows.length} creators. Sorted by ${SORTS[sort].toLowerCase()}. Attributed sales join once the Amazon reports are imported.`}>
        <Button asChild variant="outline">
          <Link href="/influencers">All creators</Link>
        </Button>
      </PageHeader>

      <div className="mb-6 grid gap-3">
        <nav aria-label="Sort" className="flex flex-wrap gap-1.5">
          {(Object.keys(SORTS) as SortKey[]).map((key) => (
            <Link key={key} href={href({ sort: key, page: undefined })} className="chip" aria-current={sort === key ? "true" : undefined}>
              {SORTS[key]}
            </Link>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-1.5">
          {(Object.keys(WORKED) as WorkedKey[]).map((key) => (
            <Link key={key} href={href({ worked: key, page: undefined })} className="chip" aria-current={worked === key ? "true" : undefined}>
              {WORKED[key]}
            </Link>
          ))}
          <span className="mx-1 text-muted-foreground">·</span>
          <Link href={href({ us: usOnly ? undefined : "1", page: undefined })} className="chip" aria-current={usOnly ? "true" : undefined}>
            US based
          </Link>
          {tiers.length > 0 ? <span className="mx-1 text-muted-foreground">·</span> : null}
          {tiers.map((value) => (
            <Link key={value} href={href({ tier: tier === value ? undefined : value, page: undefined })} className="chip capitalize" aria-current={tier === value ? "true" : undefined}>
              Amazon {value}
            </Link>
          ))}
        </div>
        <form method="get" className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="sort" value={sort} />
          <input type="hidden" name="worked" value={worked} />
          {usOnly ? <input type="hidden" name="us" value="1" /> : null}
          {tier ? <input type="hidden" name="tier" value={tier} /> : null}
          <label className="grid gap-1 text-xs text-muted-foreground">
            Search name, handle or bio
            <Input name="q" type="search" defaultValue={q} className="h-9 w-64 max-md:h-11" />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            Followers at least
            <Input name="min" type="number" min={0} step={1000} defaultValue={minFollowers || ""} className="h-9 w-32 max-md:h-11" />
          </label>
          <Button type="submit" size="sm" variant="outline">
            Apply
          </Button>
        </form>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>Creator</TableHead>
            <TableHead>Profiles</TableHead>
            <TableHead className="text-right">Followers</TableHead>
            <TableHead className="text-right">Engagement</TableHead>
            <TableHead className="text-right">Gifts</TableHead>
            <TableHead className="text-right">Posts</TableHead>
            <TableHead className="text-right">Content rate</TableHead>
            <TableHead>Amazon</TableHead>
            <TableHead>Last collaboration</TableHead>
            <TableHead>Record</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.length === 0 ? (
            <EmptyRow colSpan={11}>No creators match these filters.</EmptyRow>
          ) : (
            shown.map((row, index) => (
              <TableRow key={row.id}>
                <TableCell className="text-muted-foreground tabular-nums">{(page - 1) * PAGE_SIZE + index + 1}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <Avatar name={row.name} />
                    <div className="min-w-0">
                      <Link href={`/influencers/${row.id}`} className="font-medium text-foreground hover:text-primary-text">
                        {row.name}
                      </Link>
                      {row.location ? <div className="text-xs text-muted-foreground">{row.location}</div> : null}
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <ProfileLinks profiles={row.profiles} />
                </TableCell>
                <TableCell className="text-right tabular-nums">{row.followers ? formatCount(row.followers) : ""}</TableCell>
                <TableCell className="text-right tabular-nums">{row.engagement ? `${row.engagement.toFixed(1)}%` : ""}</TableCell>
                <TableCell className="text-right tabular-nums">{row.gifts || ""}</TableCell>
                <TableCell className="text-right tabular-nums">{row.posts || ""}</TableCell>
                <TableCell className="text-right tabular-nums">{row.rate === null ? "" : `${row.rate}%`}</TableCell>
                <TableCell className="whitespace-normal">
                  {row.tier ? (
                    <span className="capitalize">
                      {row.tier}
                      {row.gmv !== null ? <span className="text-muted-foreground"> · ${row.gmv.toLocaleString("en-US", { maximumFractionDigits: 0 })} a month</span> : null}
                    </span>
                  ) : (
                    ""
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground">{formatDay(row.lastCollaboration)}</TableCell>
                <TableCell>{row.record ? <Pill tone={row.record.tone}>{row.record.text}</Pill> : null}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {lastPage > 1 ? (
        <div className="mt-4 flex items-center justify-between">
          <span className="text-muted-foreground">
            Page {page} of {lastPage}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Button asChild size="sm" variant="outline">
                <Link href={href({ page: String(page - 1) })}>Previous</Link>
              </Button>
            ) : null}
            {page < lastPage ? (
              <Button asChild size="sm" variant="outline">
                <Link href={href({ page: String(page + 1) })}>Next</Link>
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
