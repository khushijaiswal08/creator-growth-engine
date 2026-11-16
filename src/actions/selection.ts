"use server";

import { headers } from "next/headers";
import { field, type FormState } from "@/lib/form";
import { callerIp, hitRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { recordSelection } from "@/lib/selection-flow";

/**
 * PUBLIC: called from the creator's product-selection page, with no sign-in.
 * Every check lives in recordSelection; this only slows down anyone hammering it.
 */
export async function submitSelection(_prev: FormState, formData: FormData): Promise<FormState> {
  // A hidden field people never see; bots fill it in.
  if (field(formData, "website")) return { message: "Thank you." };
  if (field(formData, "consent") !== "yes") {
    return { error: "Please tick the box to let us use these details for shipping." };
  }
  if (await hitRateLimit(RATE_LIMITS.selectionSubmit, callerIp(await headers()))) {
    return { error: "Too many attempts from this connection. Please try again in an hour." };
  }

  const result = await recordSelection(field(formData, "token"), field(formData, "productId"), {
    shipName: field(formData, "shipName"),
    address1: field(formData, "address1"),
    address2: field(formData, "address2"),
    city: field(formData, "city"),
    state: field(formData, "state"),
    postalCode: field(formData, "postalCode"),
    country: field(formData, "country"),
    phone: field(formData, "phone"),
    note: field(formData, "note"),
  });
  if (!result.ok) return { error: result.error };

  // No revalidatePath here. Revalidating from a Server Action makes Next.js re-render the page the
  // caller is on, and this caller is the creator on /select/<token>: recordSelection has just spent
  // that token, so the re-render answered "This link is no longer active" in place of this thank-you.
  // The team's pages need nothing: they are rendered fresh for every signed-in request.
  return { message: "Thank you! Your choice is in. We will send your tracking details as soon as it ships." };
}
