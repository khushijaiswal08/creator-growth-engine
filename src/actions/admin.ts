"use server";

import { randomBytes } from "node:crypto";
import { Prisma, type Platform } from "@prisma/client";
import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/activity";
import { brandName, isBrandId } from "@/lib/brands";
import { isEmail } from "@/lib/csv";
import { db } from "@/lib/db";
import { field, type FormState } from "@/lib/form";
import { displayHandle, normalizeHandle, parsePlatform, PLATFORM_LABELS } from "@/lib/profile-url";
import { requireAdmin, requireUser, type SessionUser } from "@/lib/session";

const NOT_ADMIN = { error: "Only an admin can do this." };

async function adminOrNull(): Promise<SessionUser | null> {
  const user = await requireUser();
  return user.role === "admin" ? user : null;
}

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

/* ------------------------------------------------------------------ templates */

const PURPOSES = ["first", "followup", "agreed", "selection", "reminder", "other"] as const;

export async function saveTemplate(_prev: FormState, formData: FormData): Promise<FormState> {
  const admin = await adminOrNull();
  if (!admin) return NOT_ADMIN;

  const id = field(formData, "id");
  const name = field(formData, "name");
  const purpose = field(formData, "purpose") as (typeof PURPOSES)[number];
  const body = field(formData, "body");
  if (name.length < 2 || name.length > 80) return { error: "Give the template a name of 2 to 80 characters." };
  if (!PURPOSES.includes(purpose)) return { error: "Choose a purpose." };
  if (body.length < 10) return { error: "The message is too short." };
  if (body.length > 5000) return { error: "The message is too long." };

  try {
    await db.$transaction(async (tx) => {
      if (id) await tx.template.update({ where: { id }, data: { name, purpose, body } });
      else await tx.template.create({ data: { name, purpose, body } });
      await logActivity(tx, {
        userId: admin.id,
        kind: "template_saved",
        body: `${id ? "Edited" : "Added"} message template "${name}".`,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { error: "Another template already has that name." };
    throw error;
  }

  revalidatePath("/admin/templates");
  return { message: id ? "Saved." : `Added "${name}".` };
}

export async function setTemplateArchived(templateId: string, archived: boolean): Promise<void> {
  const admin = await adminOrNull();
  if (!admin) return;

  const template = await db.template.findUnique({ where: { id: templateId }, select: { name: true, archived: true } });
  if (!template || template.archived === archived) return;

  await db.$transaction(async (tx) => {
    await tx.template.update({ where: { id: templateId }, data: { archived } });
    await logActivity(tx, {
      userId: admin.id,
      kind: "template_saved",
      body: `${archived ? "Archived" : "Restored"} message template "${template.name}".`,
    });
  });
  revalidatePath("/admin/templates");
}

/* ---------------------------------------------------------------- suppression */

export async function addSuppression(_prev: FormState, formData: FormData): Promise<FormState> {
  const admin = await adminOrNull();
  if (!admin) return NOT_ADMIN;

  const reason = field(formData, "reason");
  if (reason.length < 3 || reason.length > 300) return { error: "Give a reason of 3 to 300 characters." };

  const email = field(formData, "email").toLowerCase();
  const rawHandle = field(formData, "handle");
  if (Boolean(email) === Boolean(rawHandle)) return { error: "Enter either an email, or a platform and handle." };

  let data: { email: string; reason: string } | { platform: Platform; handle: string; reason: string };
  let label: string;
  if (email) {
    if (!isEmail(email)) return { error: "That email is not valid." };
    data = { email, reason };
    label = email;
  } else {
    const platform = parsePlatform(field(formData, "platform"));
    if (!platform) return { error: "Choose a platform for the handle." };
    const handle = normalizeHandle(platform, rawHandle);
    if (!handle) return { error: "That handle is not valid for the platform." };
    data = { platform, handle, reason };
    label = `${PLATFORM_LABELS[platform]} ${displayHandle(handle)}`;
  }

  try {
    await db.$transaction(async (tx) => {
      await tx.suppression.create({ data });
      await logActivity(tx, {
        userId: admin.id,
        kind: "suppression_added",
        body: `Added ${label} to the do-not-contact list. Reason: ${reason}`,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { error: `${label} is already on the list.` };
    throw error;
  }

  revalidatePath("/admin/suppression");
  return { message: `Added ${label}.` };
}

export async function removeSuppression(_prev: FormState, formData: FormData): Promise<FormState> {
  const admin = await adminOrNull();
  if (!admin) return NOT_ADMIN;

  const id = field(formData, "id");
  const reason = field(formData, "reason");
  if (reason.length < 3 || reason.length > 300) return { error: "Say why it is being removed (3 to 300 characters)." };

  const row = await db.suppression.findUnique({ where: { id } });
  if (!row) return { error: "That entry was already removed." };
  const label = row.email ?? `${PLATFORM_LABELS[row.platform!]} ${displayHandle(row.handle!)}`;

  // The row itself goes; the Activity log keeps who removed it, when and why.
  await db.$transaction(async (tx) => {
    await tx.suppression.delete({ where: { id } });
    await logActivity(tx, {
      userId: admin.id,
      kind: "suppression_removed",
      body: `Removed ${label} from the do-not-contact list (it was added because: ${row.reason}). Reason for removal: ${reason}`,
    });
  });

  revalidatePath("/admin/suppression");
  return { message: `Removed ${label}.` };
}

/* ---------------------------------------------------------------------- users */

export type UserFormState = { error?: string; message?: string; temporaryPassword?: string } | null;

/** How long a temporary password works before the user needs a new one. */
const TEMP_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000;

function temporaryPassword(): string {
  return randomBytes(9).toString("base64url");
}

const temporaryPasswordExpiry = () => new Date(Date.now() + TEMP_PASSWORD_TTL_MS);

/**
 * The brand chosen for a user on the form: one brand, or null for both.
 * An admin runs the whole portal, so an admin always has both.
 */
function chosenBrand(formData: FormData, role: string): { brandId: string | null } | { error: string } {
  const raw = field(formData, "brandId");
  if (raw !== "" && !isBrandId(raw)) return { error: "Choose a brand, or both brands." };
  return { brandId: role === "admin" || raw === "" ? null : raw };
}

const seesLabel = (brandId: string | null) => (brandId ? brandName(brandId) : "both brands");

export async function createUser(_prev: UserFormState, formData: FormData): Promise<UserFormState> {
  const admin = await adminOrNull();
  if (!admin) return NOT_ADMIN;

  const name = field(formData, "name");
  const email = field(formData, "email").toLowerCase();
  const role = field(formData, "role");
  if (name.length < 2 || name.length > 80) return { error: "Enter the person's name." };
  if (!isEmail(email)) return { error: "Enter a valid email." };
  if (role !== "admin" && role !== "marketer") return { error: "Choose a role." };
  const brand = chosenBrand(formData, role);
  if ("error" in brand) return brand;

  const password = temporaryPassword();
  try {
    await db.$transaction(async (tx) => {
      await tx.user.create({
        data: {
          name,
          email,
          role,
          brandId: brand.brandId,
          passwordHash: await bcrypt.hash(password, 12),
          mustChangePassword: true,
          tempPasswordExpiresAt: temporaryPasswordExpiry(),
        },
      });
      await logActivity(tx, {
        userId: admin.id,
        kind: "user_admin",
        body: `Created user ${name} (${email}) as ${role}, working on ${seesLabel(brand.brandId)}.`,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { error: "A user with that email already exists." };
    throw error;
  }

  revalidatePath("/admin/users");
  return { message: `Created ${name}. Give them this temporary password; it is shown only once and works for 24 hours.`, temporaryPassword: password };
}

export async function updateUser(_prev: UserFormState, formData: FormData): Promise<UserFormState> {
  const admin = await adminOrNull();
  if (!admin) return NOT_ADMIN;

  const id = field(formData, "id");
  const name = field(formData, "name");
  const email = field(formData, "email").toLowerCase();
  const role = field(formData, "role");
  if (name.length < 2 || name.length > 80) return { error: "Enter the person's name." };
  if (!isEmail(email)) return { error: "Enter a valid email." };
  if (role !== "admin" && role !== "marketer") return { error: "Choose a role." };
  const brand = chosenBrand(formData, role);
  if ("error" in brand) return brand;

  const current = await db.user.findUnique({ where: { id } });
  if (!current) return { error: "That user no longer exists." };
  if (current.id === admin.id && role !== "admin") return { error: "You cannot remove your own admin role." };

  const changes = [
    current.name !== name && `name to ${name}`,
    current.email !== email && `email to ${email}`,
    current.role !== role && `role to ${role}`,
    current.brandId !== brand.brandId && `brand to ${seesLabel(brand.brandId)}`,
  ].filter(Boolean);
  if (changes.length === 0) return { message: "No changes to save." };

  try {
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { name, email, role, brandId: brand.brandId } });
      await logActivity(tx, {
        userId: admin.id,
        kind: "user_admin",
        body: `Changed user ${current.name} (${current.email}): ${changes.join(", ")}.`,
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { error: "Another user already has that email." };
    throw error;
  }

  revalidatePath("/admin/users");
  return { message: "Saved." };
}

export async function resetUserPassword(_prev: UserFormState, formData: FormData): Promise<UserFormState> {
  const admin = await adminOrNull();
  if (!admin) return NOT_ADMIN;

  const id = field(formData, "id");
  if (id === admin.id) return { error: "Use Change password for your own account." };
  const target = await db.user.findUnique({ where: { id }, select: { name: true, email: true } });
  if (!target) return { error: "That user no longer exists." };

  const password = temporaryPassword();
  await db.$transaction(async (tx) => {
    await tx.user.update({
      where: { id },
      data: {
        passwordHash: await bcrypt.hash(password, 12),
        mustChangePassword: true,
        tempPasswordExpiresAt: temporaryPasswordExpiry(),
      },
    });
    await logActivity(tx, { userId: admin.id, kind: "user_admin", body: `Reset the password of ${target.name} (${target.email}).` });
  });

  revalidatePath("/admin/users");
  return {
    message: `Temporary password for ${target.name}. It is shown only once, works for 24 hours, and they must change it at sign-in.`,
    temporaryPassword: password,
  };
}

/* ---------------------------------------------------------------- sample data */

export async function archiveSampleData(): Promise<FormState> {
  const admin = await adminOrNull();
  if (!admin) return NOT_ADMIN;

  const [influencers, campaigns] = await Promise.all([
    db.influencer.findMany({ where: { isSample: true, archived: false }, select: { id: true } }),
    db.campaign.findMany({ where: { isSample: true, status: { not: "archived" } }, select: { id: true, name: true } }),
  ]);
  if (influencers.length === 0 && campaigns.length === 0) return { message: "All sample data is already archived." };

  await db.$transaction([
    db.influencer.updateMany({ where: { id: { in: influencers.map((i) => i.id) } }, data: { archived: true } }),
    db.campaign.updateMany({ where: { id: { in: campaigns.map((c) => c.id) } }, data: { status: "archived" } }),
    db.activity.createMany({
      data: [
        ...influencers.map((i) => ({
          userId: admin.id,
          influencerId: i.id,
          kind: "influencer_archived",
          body: "Archived (sample data).",
        })),
        {
          userId: admin.id,
          kind: "sample_archived",
          body: `Archived all sample data: ${influencers.length} creators and ${campaigns.length} campaigns.`,
        },
      ],
    }),
  ]);

  revalidatePath("/admin");
  revalidatePath("/campaigns");
  revalidatePath("/influencers");
  return { message: `Archived ${influencers.length} sample creators and ${campaigns.length} sample campaigns.` };
}

/** Admin: sends last week's summary to the configured address right now, to check the email set-up. */
export async function sendWeeklySummaryNow(): Promise<FormState> {
  await requireAdmin();
  const { weeklySummary, summaryText } = await import("@/lib/weekly-summary");
  const { sendSummaryEmail } = await import("@/lib/email");
  const { subject, text } = summaryText(await weeklySummary());
  const result = await sendSummaryEmail(subject, text);
  if (!result.sent) return { error: `Not sent: ${result.reason}` };
  return { message: `Sent "${subject}" to ${process.env.SUMMARY_EMAIL_TO?.trim()}.` };
}
