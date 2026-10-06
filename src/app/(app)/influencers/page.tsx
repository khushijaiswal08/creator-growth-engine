import type { Prisma } from "@prisma/client";
import type { Metadata } from "next";
import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { EmptyRow, PageHeader, Panel } from "@/components/panel";
import { ProfileLinks } from "@/components/profile-links";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { viewed } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Creators" };

const PAGE_SIZE = 100;

export default async function InfluencersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; archived?: string; page?: string }>;
}) {
  const view = viewed(await requireUser());

  const params = await searchParams;
  const q = (params.q ?? "").trim();
  const showArchived = params.archived === "1";
  const page = Math.max(1, Number.parseInt(params.page ?? "1", 10) || 1);

  const where: Prisma.InfluencerWhereInput = {
    // Only people who are in a campaign of this person's brand (everyone, for someone looking at both).
    ...view.influencers,
    archived: showArchived,
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
            { location: { contains: q, mode: "insensitive" } },
            { profiles: { some: { handle: { contains: q.replace(/^@/, "").toLowerCase() } } } },
          ],
        }
      : {}),
  };

  const [influencers, total] = await Promise.all([
    db.influencer.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        profiles: { orderBy: { platform: "asc" } },
        // Counts the campaigns this person can see, not the other brand's.
        _count: { select: { campaigns: { where: view.creators } } },
      },
    }),
    db.influencer.count({ where }),
  ]);

  const pageHref = (target: number) => {
    const query = new URLSearchParams();
    if (q) query.set("q", q);
    if (showArchived) query.set("archived", "1");
    if (target > 1) query.set("page", String(target));
    const text = query.toString();
    return text ? `/influencers?${text}` : "/influencers";
  };
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader title="Creators" meta={`${total} ${showArchived ? "archived" : "active"}`}>
        <Button asChild variant="action">
          <Link href="/influencers/new">Add creator</Link>
        </Button>
      </PageHeader>

      <Panel>
        <form method="get" className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
          <label htmlFor="q" className="sr-only">
            Search creators
          </label>
          <Input
            id="q"
            name="q"
            type="search"
            defaultValue={q}
            placeholder="Search name, handle, email or location"
            className="h-8 max-w-sm"
          />
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" name="archived" value="1" defaultChecked={showArchived} />
            Archived
          </label>
          <Button type="submit" size="sm" variant="outline">
            Search
          </Button>
        </form>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Profiles</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Location</TableHead>
              <TableHead className="text-right">US signal</TableHead>
              <TableHead className="text-right">Campaigns</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {influencers.length === 0 ? (
              <EmptyRow colSpan={6}>
                {q ? "No creators match that search." : "No creators yet. Add one, or use the import."}
              </EmptyRow>
            ) : (
              influencers.map((influencer) => (
                <TableRow key={influencer.id}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={influencer.name} />
                      <Link href={`/influencers/${influencer.id}`} className="link">
                        {influencer.name}
                      </Link>
                    </div>
                  </TableCell>
                  <TableCell>
                    <ProfileLinks profiles={influencer.profiles} />
                  </TableCell>
                  <TableCell>{influencer.email}</TableCell>
                  <TableCell>{influencer.location}</TableCell>
                  <TableCell className="text-right tabular-nums">{influencer.usSignal}</TableCell>
                  <TableCell className="text-right tabular-nums">{influencer._count.campaigns}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        {lastPage > 1 ? (
          <div className="flex items-center justify-between border-t px-4 py-2.5">
            <span className="text-muted-foreground">
              Page {page} of {lastPage}
            </span>
            <div className="flex gap-2">
              {page > 1 ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={pageHref(page - 1)}>Previous</Link>
                </Button>
              ) : null}
              {page < lastPage ? (
                <Button asChild size="sm" variant="outline">
                  <Link href={pageHref(page + 1)}>Next</Link>
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </Panel>
    </>
  );
}
