/**
 * Creates a team member from the server, the same way Admin > Users does:
 * a temporary password that works for 24 hours and must be changed at the
 * first sign-in.
 *
 *   pnpm exec tsx --env-file=.env scripts/create-user.ts "Preeti Sharma" preeti@example.com marketer cotton-print-club --out data/preeti-login.txt
 *
 * The fourth argument is the brand the person works on (ridhi or
 * cotton-print-club), or "both". Admins always have both. With --out the
 * temporary password is written to that file and not shown on screen.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { BRANDS, isBrandId } from "../src/lib/brands";
import { isEmail } from "../src/lib/csv";
import { db } from "../src/lib/db";

const TEMP_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000;

async function main() {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outFile = outIndex >= 0 ? args[outIndex + 1] : null;
  const positional = args.filter((arg, index) => !arg.startsWith("--") && index !== outIndex + 1);
  const [name, rawEmail, role = "marketer", brand = "both"] = positional;
  const email = rawEmail?.trim().toLowerCase() ?? "";
  const usage = `Usage: create-user.ts "<name>" <email> [admin|marketer] [${BRANDS.map((b) => b.id).join("|")}|both] [--out <file>]`;
  if (!name || name.length < 2 || !isEmail(email)) throw new Error(usage);
  if (role !== "admin" && role !== "marketer") throw new Error(usage);
  if (brand !== "both" && !isBrandId(brand)) throw new Error(usage);
  if (outIndex >= 0 && !outFile) throw new Error(usage);
  // An admin runs the whole portal, so an admin always has both brands.
  const brandId = role === "admin" || brand === "both" ? null : brand;

  if (await db.user.findUnique({ where: { email }, select: { id: true } })) throw new Error(`A user with the email ${email} already exists.`);

  const password = randomBytes(9).toString("base64url");
  const passwordHash = await bcrypt.hash(password, 12);
  if (!(await bcrypt.compare(password, passwordHash))) throw new Error("The password did not verify; nothing was created.");
  const expiresAt = new Date(Date.now() + TEMP_PASSWORD_TTL_MS);
  const timeZone = process.env.APP_TIME_ZONE?.trim() || "UTC";
  const expires = `${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone }).format(expiresAt)} (${timeZone} time)`;
  if (outFile) mkdirSync(path.dirname(outFile), { recursive: true });

  const brandLabel = brandId ? (BRANDS.find((b) => b.id === brandId)?.name ?? brandId) : "both brands";
  await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { name, email, role, brandId, passwordHash, mustChangePassword: true, tempPasswordExpiresAt: expiresAt },
    });
    await tx.activity.create({
      data: {
        userId: user.id,
        kind: "user_admin",
        body: `Created user ${name} (${email}) as ${role}, working on ${brandLabel}, from the server with scripts/create-user.ts.`,
      },
    });
  });

  if (outFile) {
    writeFileSync(
      outFile,
      [
        "Creator Growth Engine login",
        "",
        `Name:               ${name}`,
        `Email:              ${email}`,
        `Temporary password: ${password}`,
        `Works on:           ${brandLabel}`,
        "",
        `This password works until ${expires}.`,
        "At the first sign-in they will be asked to choose their own password.",
        "After that, this file is out of date and can be deleted.",
        "",
      ].join("\r\n"),
      "utf8",
    );
    console.log(`Created ${name} (${role}, ${brandLabel}). Temporary password written to ${outFile} (not shown here).`);
  } else {
    console.log(`Created ${name} (${role}, ${brandLabel}). Temporary password: ${password}`);
  }
  console.log(`It works until ${expires} and must be changed at the first sign-in.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
