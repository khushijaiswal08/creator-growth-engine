/**
 * Loads Amazon's Category Listing Report for one brand from the server. It
 * does exactly what Admin > Products does when the same file is uploaded
 * there; use it when nobody is signed in, or to check a file first.
 *
 *   pnpm exec tsx --env-file=.env scripts/import-amazon-listing.ts ridhi "C:\Downloads\Ridhi report.xlsx" --check
 *   pnpm exec tsx --env-file=.env scripts/import-amazon-listing.ts cotton-print-club "C:\Downloads\CPC report.xlsx"
 *
 * With --check the result is worked out and printed but nothing is written.
 * A real run is logged in the activity log under the Automation account.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { read, utils } from "xlsx";
import { LISTING_SHEET, readListingRows } from "../src/lib/amazon-listing";
import { automationUserId } from "../src/lib/automation";
import { BRANDS, isBrandId } from "../src/lib/brands";
import { db } from "../src/lib/db";
import { importAmazonListings } from "../src/lib/products";

async function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const [brandId, file] = args.filter((arg) => !arg.startsWith("--"));
  if (!brandId || !file || !isBrandId(brandId)) {
    throw new Error(`Usage: import-amazon-listing.ts <${BRANDS.map((brand) => brand.id).join(" | ")}> <report.xlsx> [--check]`);
  }

  const sheet = read(readFileSync(file), { sheets: LISTING_SHEET }).Sheets[LISTING_SHEET];
  if (!sheet) throw new Error(`"${file}" has no "${LISTING_SHEET}" sheet, so it is not Amazon's Category Listing Report.`);
  const result = readListingRows(utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: false }));
  if ("error" in result) throw new Error(result.error);

  const report = await importAmazonListings(
    result.listings,
    brandId,
    { userId: await automationUserId(), fileName: `${path.basename(file)} (loaded from the server)` },
    { checkOnly },
  );
  if (!report || report.error) throw new Error(report?.error ?? "The import returned nothing.");

  console.log(checkOnly ? "CHECK ONLY, nothing was written." : "Imported.");
  console.log(`${result.listings.length} rows in the report. ${report.headline}`);
  for (const note of report.notes ?? []) console.log(`- ${note}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
