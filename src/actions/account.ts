"use server";

import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
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

const NAME_MAX = 120;
// A 160px JPEG is well under this; the limit keeps the users table small.
const AVATAR_MAX_CHARS = 120_000;
const AVATAR_PATTERN = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

/** The person changes their own name and photo. Email and role stay with an admin (Admin > Users). */
export async function updateProfile(_prev: FormState, formData: FormData): Promise<FormState> {
  const user = await requireUserForPasswordChange();

  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { error: "Enter your name." };
  if (name.length > NAME_MAX) return { error: `The name can have at most ${NAME_MAX} characters.` };

  const avatar = String(formData.get("avatar") ?? "");
  const removeAvatar = formData.get("removeAvatar") === "1";
  if (avatar && (avatar.length > AVATAR_MAX_CHARS || !AVATAR_PATTERN.test(avatar))) {
    return { error: "The photo could not be read. Choose a JPEG, PNG or WebP picture." };
  }

  const stored = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { name: true, avatarUrl: true } });
  const changes: string[] = [];
  if (name !== stored.name) changes.push("name");
  if (avatar) changes.push("photo");
  else if (removeAvatar && stored.avatarUrl) changes.push("photo removed");
  if (changes.length === 0) return { message: "Nothing to change." };

  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { name, avatarUrl: avatar ? avatar : removeAvatar ? null : undefined },
    });
    await logActivity(tx, { userId: user.id, kind: "user_admin", body: `Updated their profile (${changes.join(", ")}).` });
  });
  revalidatePath("/", "layout");
  return { message: "Saved." };
}
