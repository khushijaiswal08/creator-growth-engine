"use server";

import { revalidatePath } from "next/cache";
import { allowed } from "@/lib/brand-scope";
import { sendGiftToErp, type ErpSendResult } from "@/lib/erp";
import { requireUser } from "@/lib/session";

/** "Create order in ERP" in the gift drawer: sends the approved gift to the ERP and returns the link to open it there. */
export async function sendToErp(giftId: string): Promise<ErpSendResult> {
  const user = await requireUser();
  const result = await sendGiftToErp(String(giftId ?? ""), allowed(user), user.id);
  revalidatePath("/orders");
  return result;
}
