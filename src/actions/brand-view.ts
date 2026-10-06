"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { isBrandId } from "@/lib/brands";
import { BRAND_VIEW_COOKIE, requireUser } from "@/lib/session";

// Same rule as the session cookie: over HTTPS the cookie never travels over plain HTTP.
const secure = process.env.VERCEL === "1" || (process.env.AUTH_URL ?? "").startsWith("https://");

/**
 * Narrows the lists to one brand, or back to both. Only for someone whose
 * account may see both brands: it is a way of looking, not a permission, and
 * what a person may open or change never depends on it.
 */
export async function setBrandView(brandId: string): Promise<void> {
  const user = await requireUser();
  if (user.brandId !== null) return;

  const store = await cookies();
  if (isBrandId(brandId)) {
    store.set(BRAND_VIEW_COOKIE, brandId, { httpOnly: true, sameSite: "lax", path: "/", secure, maxAge: 365 * 24 * 60 * 60 });
  } else {
    store.delete(BRAND_VIEW_COOKIE);
  }
  revalidatePath("/", "layout");
}
