import type { Metadata } from "next";
import { CsvImportForm } from "@/components/csv-import-form";
import { PageHeader, Panel } from "@/components/panel";
import { viewed } from "@/lib/brand-scope";
import { CSV_MAX_ROWS } from "@/lib/csv";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "CSV import" };

// Leaves room for a large file on a slow connection to the database.
export const maxDuration = 300;

const COLUMNS: { name: string; required?: boolean; help: string }[] = [
  { name: "handle", required: true, help: "@handle, handle or the profile URL." },
  { name: "platform", required: true, help: "instagram, tiktok or youtube (ig, tt, yt also work)." },
  { name: "name", help: "The creator's name. Defaults to the handle." },
  { name: "email", help: "Also used to recognise the same person on another platform." },
  { name: "followers", help: "A number. 12,500 and 12.5k both work." },
  { name: "location", help: "Free text, e.g. Austin, TX." },
  { name: "campaign", help: "Campaign name as shown in the list. Rows without one, or naming an unknown campaign, go to the campaign chosen on the left." },
  { name: "status", help: "Status in that campaign, e.g. contacted. Defaults to discovered." },
  { name: "notes", help: "Free text." },
  { name: "owner_email", help: "Email of the team member who owns the relationship." },
];

export default async function ImportPage() {
  const user = await requireUser();
  const campaigns = await db.campaign.findMany({
    where: { ...viewed(user).campaigns, status: { not: "archived" } },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  return (
    <>
      <PageHeader title="CSV import" meta={`Up to ${CSV_MAX_ROWS} rows per file.`} />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* Someone tied to one brand must say which campaign the creators belong to. */}
        <CsvImportForm campaigns={campaigns} campaignRequired={user.brandId !== null} />

        <Panel title="Columns" className="self-start">
          <dl className="divide-y">
            {COLUMNS.map((column) => (
              <div key={column.name} className="grid grid-cols-[7rem_1fr] gap-x-3 px-4 py-2">
                <dt className="font-medium">
                  {column.name}
                  {column.required ? <span className="text-xs text-muted-foreground"> required</span> : null}
                </dt>
                <dd className="text-muted-foreground">{column.help}</dd>
              </div>
            ))}
          </dl>
          <p className="border-t px-4 py-2.5 text-muted-foreground">
            Rows are matched on platform and handle. An existing profile is never overwritten: only its
            blank fields are filled.
          </p>
        </Panel>
      </div>
    </>
  );
}
