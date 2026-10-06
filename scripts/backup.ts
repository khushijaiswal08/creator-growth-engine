/**
 * Writes every table to one JSON file under data/backups/ (git-ignored).
 *
 *   pnpm db:backup
 *
 * This is a second copy you hold yourself. The primary backup is Neon's own
 * (branches and point-in-time restore; see "Backups" in the README). The file
 * contains personal data and password hashes: keep it private.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const host = new URL(process.env.DATABASE_URL ?? "").hostname;

  // Parents first, so the file can be loaded back in this order.
  const tables = {
    user: await db.user.findMany(),
    template: await db.template.findMany(),
    campaign: await db.campaign.findMany(),
    influencer: await db.influencer.findMany(),
    socialProfile: await db.socialProfile.findMany(),
    discoveryRun: await db.discoveryRun.findMany(),
    scoringRun: await db.scoringRun.findMany(),
    campaignCreator: await db.campaignCreator.findMany(),
    fitAssessment: await db.fitAssessment.findMany(),
    agreement: await db.agreement.findMany(),
    post: await db.post.findMany(),
    metric: await db.metric.findMany(),
    feedback: await db.feedback.findMany(),
    message: await db.message.findMany(),
    activity: await db.activity.findMany(),
    suppression: await db.suppression.findMany(),
    product: await db.product.findMany(),
    giftOrder: await db.giftOrder.findMany(),
    automationRun: await db.automationRun.findMany(),
    hashtag: await db.hashtag.findMany(),
  };

  const takenAt = new Date();
  const directory = path.join("data", "backups");
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `backup-${takenAt.toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ takenAt, host, tables }));

  const counts = Object.entries(tables)
    .map(([name, rows]) => `${name} ${rows.length}`)
    .join(", ");
  console.log(`Backup of ${host} written to ${file}`);
  console.log(counts);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
