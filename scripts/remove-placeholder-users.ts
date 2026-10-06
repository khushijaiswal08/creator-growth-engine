/**
 * Removes the two placeholder accounts the first seed created
 * (marketer1@example.com, marketer2@example.com).
 *
 *   pnpm exec tsx --env-file=.env scripts/remove-placeholder-users.ts            (shows what would happen)
 *   pnpm exec tsx --env-file=.env scripts/remove-placeholder-users.ts --apply    (does it)
 *
 * A placeholder is only removed when it has done nothing: no messages, no
 * activity, no feedback, no discovery or scoring runs. Creators it "owns"
 * become unassigned. Anything with history is left alone and reported.
 */
import { PrismaClient } from "@prisma/client";

const PLACEHOLDERS = ["marketer1@example.com", "marketer2@example.com"];
const apply = process.argv.includes("--apply");
const db = new PrismaClient();

async function main() {
  const users = await db.user.findMany({
    where: { email: { in: PLACEHOLDERS } },
    select: {
      id: true,
      name: true,
      email: true,
      _count: {
        select: { ownedCreators: true, messages: true, activities: true, feedback: true, discoveryRuns: true, scoringRuns: true },
      },
    },
  });
  if (users.length === 0) {
    console.log("No placeholder users found. Nothing to do.");
    return;
  }

  for (const user of users) {
    const { ownedCreators, ...history } = user._count;
    const used = Object.entries(history).filter(([, count]) => count > 0);
    if (used.length > 0) {
      console.log(`KEEP   ${user.name} <${user.email}>: has history (${used.map(([k, n]) => `${k} ${n}`).join(", ")}). Rename it in Admin > Users instead.`);
      continue;
    }
    if (!apply) {
      console.log(`WOULD REMOVE ${user.name} <${user.email}>; ${ownedCreators} creators it owns would become unassigned.`);
      continue;
    }
    await db.$transaction([
      db.campaignCreator.updateMany({ where: { ownerId: user.id }, data: { ownerId: null } }),
      db.user.delete({ where: { id: user.id } }),
    ]);
    console.log(`REMOVED ${user.name} <${user.email}>; ${ownedCreators} creators unassigned.`);
  }
  if (!apply) console.log("\nNothing was changed. Run again with --apply to remove them.");

  const remaining = await db.user.findMany({ orderBy: { createdAt: "asc" }, select: { name: true, email: true, role: true } });
  console.log(`\nUsers now: ${remaining.map((u) => `${u.name} <${u.email}> (${u.role})`).join(", ")}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
