/**
 * Imports creators from a CSV file from the server, exactly as the CSV import
 * screen does (same columns, same rules: matched on platform + handle, blank
 * fields filled, nothing overwritten). Use it for a list that arrives when
 * nobody is signed in, or to check a file first.
 *
 *   pnpm exec tsx --env-file=.env scripts/import-creators.ts "Campaign name" data/creators.csv --check
 *   pnpm exec tsx --env-file=.env scripts/import-creators.ts "Campaign name" data/creators.csv
 *
 * Rows that name no campaign (or an unknown one) go into the named campaign.
 * With --check the result is printed but nothing is written. A real run is
 * logged in the activity log under the Automation account.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { automationUserId } from "../src/lib/automation";
import { allowed } from "../src/lib/brand-scope";
import { importCreators } from "../src/lib/creator-import";
import { db } from "../src/lib/db";

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const [campaignName, file] = args.filter((arg) => !arg.startsWith("--"));
  if (!campaignName || !file) throw new Error('Usage: import-creators.ts "<campaign name>" <file.csv> [--check]');

  const campaign = await db.campaign.findFirst({
    where: { name: { equals: campaignName, mode: "insensitive" } },
    select: { id: true, name: true, brandId: true },
  });
  if (!campaign) throw new Error(`No campaign is called "${campaignName}".`);

  const userId = await automationUserId();
  const report = await importCreators(readFileSync(file, "utf8"), {
    userId,
    // The server has no brand of its own; the named campaign decides where the rows go.
    scope: allowed({ id: userId, brandId: null, viewBrand: null }),
    fallbackCampaignId: campaign.id,
    fileName: `${path.basename(file)} (loaded from the server)`,
    checkOnly,
  });
  if (!report.ok) throw new Error(report.error);

  console.log(checkOnly ? "CHECK ONLY, nothing was written." : "Imported.");
  console.log(`Into "${campaign.name}" (${campaign.brandId}): ${report.added} added, ${report.updated} updated, ${report.skipped} skipped.`);
  if (report.ignoredColumns.length > 0) console.log(`Columns not recognised and ignored: ${report.ignoredColumns.join(", ")}.`);
  const noteworthy = report.details.filter((d) => d.outcome === "skipped" || d.notes.some((n) => !/^Added to campaign/.test(n)));
  for (const detail of noteworthy.slice(0, 60)) {
    console.log(`  row ${detail.row} ${detail.platform} ${detail.handle}: ${detail.outcome}. ${detail.notes.join(" ")}`);
  }
  if (noteworthy.length > 60) console.log(`  ... and ${noteworthy.length - 60} more rows with notes.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
