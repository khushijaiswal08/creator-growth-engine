import type { Metadata } from "next";
import Link from "next/link";
import { EmptyRow, PageHeader, Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { viewed } from "@/lib/brand-scope";
import { brandName } from "@/lib/brands";
import { db } from "@/lib/db";
import { formatCalendarDay } from "@/lib/format";
import { requireUser } from "@/lib/session";
import { CampaignStatusPill } from "@/components/status-pill";

export const metadata: Metadata = { title: "Campaigns" };

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string }>;
}) {
  const view = viewed(await requireUser());
  const showArchived = (await searchParams).archived === "1";

  const [campaigns, archivedCount] = await Promise.all([
    db.campaign.findMany({
      where: { ...view.campaigns, status: showArchived ? "archived" : { not: "archived" } },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { creators: true } } },
    }),
    db.campaign.count({ where: { ...view.campaigns, status: "archived" } }),
  ]);

  return (
    <>
      <PageHeader title={showArchived ? "Archived campaigns" : "Campaigns"}>
        {showArchived ? (
          <Button asChild variant="outline">
            <Link href="/campaigns">Back to campaigns</Link>
          </Button>
        ) : archivedCount > 0 ? (
          <Button asChild variant="outline">
            <Link href="/campaigns?archived=1">Archived ({archivedCount})</Link>
          </Button>
        ) : null}
        <Button asChild variant="action">
          <Link href="/campaigns/new">New campaign</Link>
        </Button>
      </PageHeader>

      <Panel>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Brand</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Creators</TableHead>
              <TableHead className="text-right">Target posts</TableHead>
              <TableHead>Deadline</TableHead>
              <TableHead>Niche keywords</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.length === 0 ? (
              <EmptyRow colSpan={7}>
                {showArchived ? "No archived campaigns." : "No campaigns yet. Create the first one."}
              </EmptyRow>
            ) : (
              campaigns.map((campaign) => (
                <TableRow key={campaign.id}>
                  <TableCell>
                    <Link href={`/campaigns/${campaign.id}`} className="link">
                      {campaign.name}
                    </Link>
                  </TableCell>
                  <TableCell>{brandName(campaign.brandId)}</TableCell>
                  <TableCell>
                    <CampaignStatusPill status={campaign.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{campaign._count.creators}</TableCell>
                  <TableCell className="text-right tabular-nums">{campaign.targetPosts ?? ""}</TableCell>
                  <TableCell>{formatCalendarDay(campaign.deadline)}</TableCell>
                  <TableCell className="max-w-md truncate text-muted-foreground">
                    {campaign.nicheKeywords.join(", ")}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Panel>
    </>
  );
}
