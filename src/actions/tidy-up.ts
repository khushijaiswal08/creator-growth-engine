"use server";

import { revalidatePath } from "next/cache";
import { viewed } from "@/lib/brand-scope";
import { applyTidyChunk, undoTidyUp, type ApplyResult, type UndoResult } from "@/lib/tidy-up";
import type { TidyAction, TidyGroupKey } from "@/lib/tidy-up-rules";
import { requireAdmin } from "@/lib/session";

/**
 * Admin > Tidy up old work: one chunk of the choices the preview showed.
 * Admins only. It works inside the brand view the page was opened in, so a
 * tidy-up started with only Ridhi showing never touches Cotton Print Club;
 * if the view has changed since, it stops and asks for a fresh preview.
 */
export async function applyTidyUp(input: { days: number; group: TidyGroupKey; action: TidyAction; ids: string[]; tidyUpId: string | null; brand: string | null }): Promise<ApplyResult> {
  const user = await requireAdmin();
  const view = viewed(user);
  if ((view.brandId ?? null) !== (typeof input?.brand === "string" ? input.brand : null)) {
    return { ok: false, error: "The brand view changed since this page was opened. Reload the page to see the new preview." };
  }
  const result = await applyTidyChunk({
    scope: view,
    userId: user.id,
    days: Number(input?.days),
    group: input?.group,
    action: input?.action,
    ids: Array.isArray(input?.ids) ? input.ids.map(String) : [],
    tidyUpId: typeof input?.tidyUpId === "string" ? input.tidyUpId : null,
  });
  revalidatePath("/admin/tidy-up");
  revalidatePath("/");
  revalidatePath("/today");
  return result;
}

/** Undo for one tidy-up, a chunk at a time; the page calls it until nothing is left. */
export async function undoTidy(tidyUpId: string): Promise<UndoResult> {
  const user = await requireAdmin();
  const result = await undoTidyUp({ tidyUpId: String(tidyUpId ?? ""), userId: user.id });
  revalidatePath("/admin/tidy-up");
  revalidatePath("/");
  revalidatePath("/today");
  return result;
}
