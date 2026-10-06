/**
 * One-off data setup for the automated journey, safe to run again:
 *
 *   - adds the "Product selection link" and "Content reminder" templates
 *   - makes the first-touch template use {brand} so it works for both brands
 *   - runs the automation once so every open creator gets a next action
 *
 *   pnpm exec tsx --env-file=.env scripts/setup-journey.ts
 */
import { PrismaClient } from "@prisma/client";
import { runAutomations } from "../src/lib/automation";

const db = new PrismaClient();

const TEMPLATES = [
  {
    name: "Product selection link",
    purpose: "selection" as const,
    body: `Hi {name},

So glad you'd like to work with {brand}! Please choose the piece you'd love and tell us where to send it here:

{selection_link}

It takes about a minute, and the link is just for you.

{sender}`,
  },
  {
    name: "Content reminder",
    purpose: "reminder" as const,
    body: `Hi {name},

I hope your {brand} piece arrived safely and you're enjoying it. We'd love to see it in your space whenever you have a moment to share. If you post, please tag us and mention that it was gifted.

Let me know if you need anything from us.

{sender}`,
  },
];

async function main() {
  for (const template of TEMPLATES) {
    const existing = await db.template.findUnique({ where: { name: template.name } });
    if (!existing) await db.template.create({ data: template });
    console.log(`${existing ? "kept" : "added"} template "${template.name}"`);
  }

  const first = await db.template.findUnique({ where: { name: "First touch" } });
  if (first?.body.includes("from Ridhi Block Print.")) {
    await db.template.update({ where: { id: first.id }, data: { body: first.body.replace("from Ridhi Block Print.", "from {brand}.") } });
    console.log('"First touch" now uses {brand}');
  }

  const summary = await runAutomations("manual");
  console.log("automation:", JSON.stringify(summary));

  const due = await db.campaignCreator.count({ where: { nextActionDueAt: { lte: new Date() } } });
  const byAction = await db.campaignCreator.groupBy({ by: ["nextAction"], _count: { _all: true }, orderBy: { _count: { nextAction: "desc" } } });
  console.log("due now:", due);
  console.log(byAction.map((row) => `${row._count._all}  ${row.nextAction ?? "(none: closed)"}`).join("\n"));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
