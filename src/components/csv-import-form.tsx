"use client";

import { useActionState } from "react";
import Link from "next/link";
import { importCsv, type ImportOutcome } from "@/actions/import";
import { NativeSelect } from "@/components/native-select";
import { Panel } from "@/components/panel";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const OUTCOME_LABELS: Record<ImportOutcome, string> = {
  added: "Added",
  updated: "Updated",
  skipped: "Skipped",
};

export function CsvImportForm({
  campaigns,
  campaignRequired,
}: {
  campaigns: { id: string; name: string }[];
  campaignRequired: boolean;
}) {
  const [report, action] = useActionState(importCsv, null);

  return (
    <div className="grid gap-4">
      <Panel title="Upload">
        <form action={action} className="grid gap-3 p-4">
          <div className="grid gap-1.5 sm:max-w-md">
            <Label htmlFor="file">CSV file</Label>
            <Input id="file" name="file" type="file" accept=".csv,text/csv" required />
          </div>
          <div className="grid gap-1.5 sm:max-w-md">
            <Label htmlFor="import-campaign">{campaignRequired ? "Add to campaign" : "Add to campaign (optional)"}</Label>
            <NativeSelect id="import-campaign" name="campaignId" defaultValue="" required={campaignRequired}>
              <option value="">{campaignRequired ? "Choose a campaign" : "No campaign"}</option>
              {campaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.name}
                </option>
              ))}
            </NativeSelect>
            <p className="text-xs text-muted-foreground">
              Used for every row that does not name a campaign of its own.
              {campaignRequired && campaigns.length === 0 ? (
                <>
                  {" "}
                  There is no campaign yet:{" "}
                  <Link href="/campaigns/new" className="link">
                    create one first
                  </Link>
                  .
                </>
              ) : null}
            </p>
          </div>
          {report && !report.ok ? (
            <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive">
              {report.error}
            </p>
          ) : null}
          <div>
            <SubmitButton variant="action" pendingLabel="Importing...">
              Import
            </SubmitButton>
          </div>
        </form>
      </Panel>

      {report?.ok ? (
        <Panel title={`Result for ${report.fileName}`}>
          <dl className="grid grid-cols-3 divide-x border-b text-center" role="status">
            {(["added", "updated", "skipped"] as const).map((outcome) => (
              <div key={outcome} className="px-4 py-3">
                <dt className="eyebrow">
                  {OUTCOME_LABELS[outcome]}
                </dt>
                <dd className="stat-number text-2xl">{report[outcome]}</dd>
              </div>
            ))}
          </dl>
          {report.ignoredColumns.length > 0 ? (
            <p className="border-b px-4 py-2 text-muted-foreground">
              Columns not recognised and ignored: {report.ignoredColumns.join(", ")}.
            </p>
          ) : null}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">Row</TableHead>
                <TableHead>Platform</TableHead>
                <TableHead>Handle</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Notes</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.details.map((detail) => (
                <TableRow key={detail.row}>
                  <TableCell className="tabular-nums">{detail.row}</TableCell>
                  <TableCell>{detail.platform}</TableCell>
                  <TableCell>{detail.handle}</TableCell>
                  <TableCell className={detail.outcome === "skipped" ? "font-medium text-destructive" : "font-medium"}>
                    {OUTCOME_LABELS[detail.outcome]}
                  </TableCell>
                  <TableCell className="whitespace-normal text-muted-foreground">{detail.notes.join(" ")}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Panel>
      ) : null}
    </div>
  );
}
