/**
 * Resets one user's password from the server, for when nobody can sign in to
 * do it from Admin > Users (for example the only admin forgot theirs).
 *
 *   pnpm exec tsx --env-file=.env scripts/reset-password.ts someone@example.com
 *   pnpm exec tsx --env-file=.env scripts/reset-password.ts someone@example.com --out data/my-login.txt
 *
 * The user gets a temporary password that works for 24 hours and must be
 * changed at sign-in, exactly like a reset from the Users screen. Sign-in
 * lockouts are cleared too. With --out the password is written to that file
 * and not shown on screen; without it, it is printed once.
 *
 * Passwords are stored as one-way hashes: the old one cannot be read back by
 * anyone, which is why this resets rather than reveals.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const TEMP_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000;

const db = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outValueIndex = outIndex >= 0 ? outIndex + 1 : -1;
  const outFile = outIndex >= 0 ? args[outValueIndex] : null;
  const email = args.find((arg, index) => !arg.startsWith("--") && index !== outValueIndex)?.trim().toLowerCase();
  if (!email || (outIndex >= 0 && !outFile)) {
    throw new Error("Usage: reset-password.ts <email> [--out <file>]");
  }

  const user = await db.user.findUnique({ where: { email }, select: { id: true, name: true, isSystem: true } });
  if (!user || user.isSystem) throw new Error(`No user with the email ${email}.`);

  const password = randomBytes(9).toString("base64url");
  const passwordHash = await bcrypt.hash(password, 12);
  if (!(await bcrypt.compare(password, passwordHash))) throw new Error("The new password did not verify; nothing was changed.");
  const expiresAt = new Date(Date.now() + TEMP_PASSWORD_TTL_MS);
  const timeZone = process.env.APP_TIME_ZONE?.trim() || "UTC";
  // Worked out before anything is changed, so nothing after the reset can fail and hide the new password.
  const expires = `${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone }).format(expiresAt)} (${timeZone} time)`;
  if (outFile) mkdirSync(path.dirname(outFile), { recursive: true });

  const [, cleared] = await db.$transaction([
    db.user.update({
      where: { id: user.id },
      data: { passwordHash, mustChangePassword: true, tempPasswordExpiresAt: expiresAt },
    }),
    // Failed attempts are stored as a hash of email + IP, so they cannot be picked out per person.
    db.loginAttempt.deleteMany({}),
    db.activity.create({
      data: { userId: user.id, kind: "user_admin", body: `Password of ${user.name} (${email}) reset from the server with scripts/reset-password.ts.` },
    }),
  ]);

  if (outFile) {
    writeFileSync(
      outFile,
      [
        "Creator Growth Engine login",
        "",
        `Email:              ${email}`,
        `Temporary password: ${password}`,
        "",
        `This password works until ${expires}.`,
        "When you sign in you will be asked to choose your own password.",
        "After that, this file is out of date and can be deleted.",
        "",
      ].join("\r\n"),
      "utf8",
    );
    console.log(`Temporary password for ${user.name} written to ${outFile} (not shown here).`);
  } else {
    console.log(`Temporary password for ${user.name} (${email}): ${password}`);
  }
  console.log(`It works until ${expires} and must be changed at sign-in. Cleared ${cleared.count} failed sign-in attempts.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
