import type { Role } from "@prisma/client";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/auth";
import { isBrandId } from "@/lib/brands";
import { db } from "@/lib/db";

/** Remembers which brand someone who may see both has chosen to look at. A preference, not a permission. */
export const BRAND_VIEW_COOKIE = "brand-view";

export type SessionUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** The brand on the account; null means both. This is what the person is allowed to see and change. */
  brandId: string | null;
  /** The brand the lists are narrowed to right now; null means both. See src/lib/brand-scope.ts. */
  viewBrand: string | null;
  /** Profile photo as a data URL, when the person has set one. */
  avatarUrl: string | null;
};

const loadSessionUser = cache(async () => {
  const session = await auth();
  const id = session?.user?.id;
  if (!id) redirect("/login");

  const user = await db.user.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, role: true, brandId: true, mustChangePassword: true, avatarUrl: true },
  });
  if (!user) redirect("/logout");

  // Admins run the whole portal, so they always have both brands whatever is stored.
  const brandId = user.role === "admin" ? null : user.brandId;
  const picked = (await cookies()).get(BRAND_VIEW_COOKIE)?.value ?? "";
  // The sidebar choice only narrows the view of someone who may see both; it can never widen anyone's.
  const viewBrand = brandId ?? (isBrandId(picked) ? picked : null);

  return { ...user, brandId, viewBrand };
});

/**
 * The signed-in user, read from the database so a removed user loses access
 * at once, and so a change of brand takes effect on the next click. Call at
 * the top of every protected page and Server Action; the middleware alone is
 * not the security boundary.
 *
 * Someone holding a temporary password is sent to choose a new one first.
 */
export async function requireUser(): Promise<SessionUser> {
  const { mustChangePassword, ...user } = await loadSessionUser();
  if (mustChangePassword) redirect("/account/password");
  return user;
}

/** For the change-password screen only: does not bounce a user who still has a temporary password. */
export async function requireUserForPasswordChange(): Promise<SessionUser & { mustChangePassword: boolean }> {
  return loadSessionUser();
}

/** Pages and actions that only admins may use. For anyone else they do not exist (404). */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "admin") notFound();
  return user;
}
