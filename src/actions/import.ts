"use server";

import { revalidatePath } from "next/cache";
import { allowed } from "@/lib/brand-scope";
import { importCreators, type ImportReport } from "@/lib/creator-import";
import { field, MAX_IMPORT_BYTES } from "@/lib/form";
import { requireUser } from "@/lib/session";

export type { ImportOutcome } from "@/lib/creator-import";

/**
 * The CSV import screen. The rules live in src/lib/creator-import.ts; this
 * only checks the file and who is asking. Rows go into the campaign they
 * name, or else into the one chosen on the form, and only campaigns of the
 * person's own brand count.
 */
export async function importCsv(_prev: ImportReport | null, formData: FormData): Promise<ImportReport> {
  const user = await requireUser();

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a CSV file." };
  if (file.size > MAX_IMPORT_BYTES) return { ok: false, error: "The file is larger than 3 MB." };

  const report = await importCreators(await file.text(), {
    userId: user.id,
    scope: allowed(user),
    fallbackCampaignId: field(formData, "campaignId"),
    fileName: file.name,
  });

  if (report.ok) {
    revalidatePath("/influencers");
    revalidatePath("/campaigns");
    for (const id of report.campaignIds) revalidatePath(`/campaigns/${id}`);
  }
  return report;
}
