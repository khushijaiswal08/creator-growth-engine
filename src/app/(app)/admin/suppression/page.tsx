import type { Metadata } from "next";
import { AddSuppressionForm, RemoveSuppressionForm } from "@/components/admin-forms";
import { EmptyRow, PageHeader, Panel } from "@/components/panel";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { db } from "@/lib/db";
import { formatDay } from "@/lib/format";
import { displayHandle, PLATFORM_LABELS } from "@/lib/profile-url";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Do-not-contact list" };

export default async function SuppressionPage() {
  await requireAdmin();

  const rows = await db.suppression.findMany({ orderBy: { createdAt: "desc" }, take: 500 });

  return (
    <>
      <PageHeader
        title="Do-not-contact list"
        meta="Anyone on this list shows Do not contact in place of the Message button, and discovery skips them."
      />

      <div className="grid gap-4">
        <Panel title="Add an entry">
          <AddSuppressionForm />
        </Panel>

        <Panel title={`On the list (${rows.length})`}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Who</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Added</TableHead>
                <TableHead>Remove</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <EmptyRow colSpan={4}>Nobody is on the list.</EmptyRow>
              ) : (
                rows.map((row) => {
                  const label = row.email ?? `${PLATFORM_LABELS[row.platform!]} ${displayHandle(row.handle!)}`;
                  return (
                    <TableRow key={row.id}>
                      <TableCell className="font-medium">{label}</TableCell>
                      <TableCell className="max-w-md whitespace-normal">{row.reason}</TableCell>
                      <TableCell>{formatDay(row.createdAt)}</TableCell>
                      <TableCell>
                        <RemoveSuppressionForm id={row.id} label={label} />
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </Panel>
      </div>
    </>
  );
}
