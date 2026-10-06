"use server";

import bcrypt from "bcryptjs";
import { redirect } from "next/navigation";
import { logActivity } from "@/lib/activity";
import { db } from "@/lib/db";
import type { FormState } from "@/lib/form";
import { requireUserForPasswordChange } from "@/lib/session";

const MIN_LENGTH = 10;

export async function changePassword(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUserForPasswordChange();

  // Passwords are taken as typed: no trimming.
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (next.length < MIN_LENGTH) return { error: `The new password needs at least ${MIN_LENGTH} characters.` };
  if (next.length > 200) return { error: "The new password is too long." };
  if (next !== confirm) return { error: "The two new passwords do not match." };
  if (next === current) return { error: "Choose a password different from the current one." };

  const stored = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { passwordHash: true } });
  if (!(await bcrypt.compare(current, stored.passwordHash))) return { error: "The current password is not correct." };

  const passwordHash = await bcrypt.hash(next, 12);
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false, tempPasswordExpiresAt: null } });
    await logActivity(tx, { userId: user.id, kind: "user_admin", body: "Changed their own password." });
  });

  redirect("/today");
}
