import type { Metadata } from "next";
import Link from "next/link";
import { EmptyRow, PageHeader, Panel } from "@/components/panel";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { viewed } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import { formatDay } from "@/lib/format";
import { replyRate, weeklyStats } from "@/lib/outreach-stats";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Outreach report" };

const WEEKS = 8;

/**
 * By person and by week for the last eight weeks: messages, replies, reply
 * rate, agreed, shipped, posted. One campaign or the whole brand. The CSV at
 * /reports/outreach/export has the same rows.
 */
export default async function OutreachReportPage({ searchParams }: { searchParams: Promise<{ campaign?: string }> }) {
  const user = await requireUser();
  const view = viewed(user);
  const campaigns = await db.campaign.findMany({ where: { ...view.campaigns, status: { not: "archived" } }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  const asked = (await searchParams).campaign;
  const chosen = campaigns.find((campaign) => campaign.id === asked) ?? null;
  const where = chosen ? { id: chosen.id } : view.campaigns;
  const weeks = await weeklyStats(where, WEEKS);
  const anyone = weeks.some((week) => week.people.length > 0);

  return (
    <>
      <PageHeader title="Outreach report" meta={`By person and by week for the last ${WEEKS} weeks. Reply rate is replies divided by the creators each person messaged.`}>
        <Button asChild variant="outline">
          <a href={`/reports/outreach/export${chosen ? `?campaign=${chosen.id}` : ""}`}>Export CSV</a>
        </Button>
      </PageHeader>

      <nav aria-label="Campaign" className="mb-6 flex flex-wrap gap-1.5">
        <Link href="/reports/outreach" className="chip" aria-current={chosen === null ? "true" : undefined}>
          All campaigns
        </Link>
        {campaigns.map((campaign) => (
          <Link key={campaign.id} href={`/reports/outreach?campaign=${campaign.id}`} className="chip" aria-current={chosen?.id === campaign.id ? "true" : undefined}>
            {campaign.name}
          </Link>
        ))}
      </nav>

      <Panel plain title="Week by week">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Week</TableHead>
              <TableHead>Person</TableHead>
              <TableHead className="text-right">Messages</TableHead>
              <TableHead className="text-right">Creators</TableHead>
              <TableHead className="text-right">Replies</TableHead>
              <TableHead className="text-right">Reply rate</TableHead>
              <TableHead className="text-right">Follow-ups</TableHead>
              <TableHead className="text-right">Agreed</TableHead>
              <TableHead className="text-right">Shipped</TableHead>
              <TableHead className="text-right">Posted</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {!anyone ? (
              <EmptyRow colSpan={10}>No messages logged in the last {WEEKS} weeks. Each message logged with the Message button counts here.</EmptyRow>
            ) : (
              weeks.flatMap((week) =>
                (week.people.length === 0 ? [null] : week.people).map((person, index) => (
                  <TableRow key={`${week.weekStart.toISOString()}-${person?.userId ?? "none"}`}>
                    <TableCell className="text-muted-foreground">{index === 0 ? formatDay(week.weekStart) : ""}</TableCell>
                    <TableCell>{person ? person.name : <span className="text-muted-foreground">Nobody</span>}</TableCell>
                    <TableCell className="text-right tabular-nums">{person?.messages ?? 0}</TableCell>
                    <TableCell className="text-right tabular-nums">{person?.creators ?? 0}</TableCell>
                    <TableCell className="text-right tabular-nums">{person?.replies ?? 0}</TableCell>
                    <TableCell className="text-right tabular-nums">{person ? (replyRate(person) === null ? "" : `${replyRate(person)}%`) : ""}</TableCell>
                    <TableCell className="text-right tabular-nums">{person?.followUps ?? 0}</TableCell>
                    <TableCell className="text-right tabular-nums">{person?.agreed ?? 0}</TableCell>
                    <TableCell className="text-right tabular-nums">{person?.shipped ?? 0}</TableCell>
                    <TableCell className="text-right tabular-nums">{person?.posted ?? 0}</TableCell>
                  </TableRow>
                )),
              )
            )}
          </TableBody>
        </Table>
      </Panel>
    </>
  );
}
