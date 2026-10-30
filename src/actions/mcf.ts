"use server";

import { revalidatePath } from "next/cache";
import { allowed } from "@/lib/brand-scope";
import { BRANDS } from "@/lib/brands";
import type { McfPreview } from "@/lib/mcf";
import { previewGiftForAmazon, sendGiftToAmazon, syncAmazonOrders, type SyncSummary } from "@/lib/mcf-flow";
import { requireUser } from "@/lib/session";

/** What Amazon would charge and when the gift would arrive. Places nothing. */
export async function previewForAmazon(giftId: string): Promise<{ ok: true; preview: McfPreview; alreadyAtAmazon: boolean } | { ok: false; error: string }> {
  const user = await requireUser();
  return previewGiftForAmazon(String(giftId ?? ""), allowed(user));
}

/** Places the gift order with Amazon MCF. Only a person pressing the button gets here; nothing is sent on its own. */
export async function sendToAmazon(giftId: string): Promise<{ ok: true; reference: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const result = await sendGiftToAmazon(String(giftId ?? ""), allowed(user), user.id);
  revalidatePath("/orders");
  revalidatePath("/today");
  return result;
}

/** "Check Amazon now": reads back what Amazon did with sent gifts right away, for the brands this person can see; the gift on screen first. */
export async function checkAmazonNow(giftId?: string): Promise<SyncSummary> {
  const user = await requireUser();
  const scope = allowed(user);
  const brandIds = BRANDS.filter((brand) => scope.includes(brand.id)).map((brand) => brand.id);
  const summary = await syncAmazonOrders(new Date(), { brandIds, budgetMs: 6_000, firstGiftId: typeof giftId === "string" ? giftId : null });
  revalidatePath("/orders");
  revalidatePath("/today");
  return summary;
}
