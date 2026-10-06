/**
 * Brand isolation, proved against the real built app:
 *
 *   pnpm build
 *   pnpm test:isolation
 *
 * Starts the production server on a throwaway in-memory Postgres with one
 * creator, campaign, product and gift order per brand, signs in as the
 * Cotton Print Club user and as the Ridhi user, and tries to reach the other
 * brand's records by direct address and by forged Server Action calls. Every
 * attempt must come back 404 (or 401 for the scheduler) and leave the
 * database untouched. Admin pages must be 404 for both marketers.
 */
import assert from "node:assert/strict";
import { exec, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const DB_PORT = 54332;
const APP_PORT = 3999;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const DB_URL = `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres?sslmode=disable&connection_limit=1&pgbouncer=true`;
const PASSWORD = "Test-password-1";

let pglite: PGlite;
let socket: PGLiteSocketServer;
let server: ChildProcess;
let db: PrismaClient;

type BrandFixture = {
  id: "ridhi" | "cotton-print-club";
  user: { email: string };
  campaignId: string;
  influencerId: string;
  creatorId: string;
  productId: string;
  giftId: string;
};
const fixtures: Record<string, BrandFixture> = {};

/** Server Action ids by exported name, from the manifest the build writes. */
function actionIds(): Map<string, string> {
  const manifest = JSON.parse(readFileSync(path.resolve(".next/server/server-reference-manifest.json"), "utf8")) as {
    node: Record<string, { exportedName?: string }>;
  };
  const ids = new Map<string, string>();
  for (const [id, entry] of Object.entries(manifest.node)) {
    if (entry.exportedName) ids.set(entry.exportedName, id);
  }
  return ids;
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("The production server did not start. Run `pnpm build` first.");
}

/** Signs in through Auth.js the way the browser does, and returns the session cookie. */
async function signIn(email: string): Promise<string> {
  const csrf = await fetch(`${BASE}/api/auth/csrf`);
  const { csrfToken } = (await csrf.json()) as { csrfToken: string };
  const jar = csrf.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const response = await fetch(`${BASE}/api/auth/callback/credentials`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar },
    body: new URLSearchParams({ email, password: PASSWORD, csrfToken, callbackUrl: `${BASE}/today` }),
  });
  const session = response.headers.getSetCookie().find((c) => c.includes("session-token="));
  assert.ok(session && !session.includes("session-token=;"), `sign-in as ${email} should set a session cookie (status ${response.status})`);
  return session.split(";")[0];
}

async function get(cookie: string, pathname: string): Promise<Response> {
  return fetch(`${BASE}${pathname}`, { headers: { cookie }, redirect: "manual" });
}

/** Calls a Server Action directly, as a tampered browser would. */
async function callAction(cookie: string, id: string, args: unknown[]): Promise<Response> {
  return fetch(`${BASE}/today`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "next-action": id, "content-type": "text/plain;charset=UTF-8", accept: "text/x-component" },
    body: JSON.stringify(args),
  });
}

before(async () => {
  assert.ok(existsSync(path.resolve(".next/BUILD_ID")), "No production build found: run `pnpm build` first.");

  pglite = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pglite, port: DB_PORT, host: "127.0.0.1", maxConnections: 10 });
  await socket.start();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    DATABASE_URL: DB_URL,
    DIRECT_URL: DB_URL,
    AUTH_SECRET: randomBytes(33).toString("base64"),
    AUTH_TRUST_HOST: "true",
    APP_URL: BASE,
    ADDRESS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    CRON_SECRET: "test-cron-secret",
    PORT: String(APP_PORT),
  };
  await promisify(exec)("pnpm exec prisma migrate deploy", { env });

  const { PrismaClient } = await import("@prisma/client");
  db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

  const hash = await bcrypt.hash(PASSWORD, 4);
  for (const brand of ["ridhi", "cotton-print-club"] as const) {
    const user = await db.user.create({
      data: { name: `${brand} marketer`, email: `${brand}@example.com`, passwordHash: hash, role: "marketer", brandId: brand },
    });
    const campaign = await db.campaign.create({
      data: { name: `${brand} campaign`, brandId: brand, brief: "Gifting.", nicheKeywords: ["home"], negativeKeywords: [], status: "active" },
    });
    const influencer = await db.influencer.create({
      data: { name: `${brand} creator`, profiles: { create: { platform: "instagram", handle: `${brand}_creator` } } },
    });
    const creator = await db.campaignCreator.create({
      data: { campaignId: campaign.id, influencerId: influencer.id, status: "address_collected", ownerId: user.id },
    });
    const product = await db.product.create({
      data: { brandId: brand, sku: `${brand}-SKU`, title: "Tablecloth", stock: 5, amazonUrl: "https://www.amazon.com/dp/B0ISOLATION" },
    });
    const gift = await db.giftOrder.create({
      data: {
        campaignCreatorId: creator.id,
        productId: product.id,
        status: "approved",
        shipName: "Someone",
        address1: "1 Street",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "United States",
      },
    });
    fixtures[brand] = { id: brand, user, campaignId: campaign.id, influencerId: influencer.id, creatorId: creator.id, productId: product.id, giftId: gift.id };
  }

  server = spawn("pnpm", ["exec", "next", "start", "-p", String(APP_PORT), "-H", "127.0.0.1"], { env, shell: true, stdio: "ignore" });
  await waitForServer();
});

after(async () => {
  if (server?.pid) await promisify(exec)(`taskkill /PID ${server.pid} /T /F`).catch(() => undefined);
  await db?.$disconnect();
  await socket?.stop();
  await pglite?.close();
});

for (const [mine, theirs] of [
  ["cotton-print-club", "ridhi"],
  ["ridhi", "cotton-print-club"],
] as const) {
  test(`the ${mine} user cannot reach ${theirs} records by address, file, admin page or forged action`, async () => {
    const me = fixtures[mine];
    const other = fixtures[theirs];
    const cookie = await signIn(me.user.email);

    // Own records open; the other brand's do not exist for this person.
    const own = await get(cookie, `/influencers/${me.influencerId}`);
    assert.equal(own.status, 200, `own creator page should open (redirected to ${own.headers.get("location")})`);
    assert.equal((await get(cookie, `/campaigns/${me.campaignId}`)).status, 200);
    const results: Record<string, number> = {};
    const refused = [
      `/influencers/${other.influencerId}`,
      `/campaigns/${other.campaignId}`,
      `/campaigns/${other.campaignId}/review`,
      `/campaigns/${other.campaignId}/export`,
      `/campaigns/${other.campaignId}/review/export`,
      `/orders/export?brand=${theirs}`,
      "/admin",
      "/admin/products",
      "/admin/users",
      "/admin/templates",
      "/admin/suppression",
    ];
    for (const pathname of refused) {
      const status = (await get(cookie, pathname)).status;
      results[pathname] = status;
      assert.ok(status === 404 || status === 403, `${pathname} answered ${status} for the ${mine} user`);
    }
    // The orders file for the own brand works, and never carries the other brand's order.
    const file = await (await get(cookie, `/orders/export?brand=${mine}`)).text();
    assert.match(file, new RegExp(`${mine}-SKU`));
    assert.doesNotMatch(file, new RegExp(`${theirs}-SKU`));
    // The scheduler endpoint needs its secret, cookie or not.
    assert.equal((await get(cookie, "/api/cron/automations")).status, 401);
    assert.equal((await get(cookie, "/api/cron/weekly-summary")).status, 401);
    // The public health check reveals nothing but up or down.
    assert.deepEqual(Object.keys(await (await fetch(`${BASE}/health`)).json()).sort(), ["database", "status"]);

    // Forged Server Actions against the other brand's records change nothing.
    const ids = actionIds();
    for (const name of ["updateCreatorStatus", "decideGift", "markDelivered", "setInfluencerArchived"]) {
      assert.ok(ids.has(name), `action id for ${name} found in the build`);
    }
    const before = {
      creator: await db.campaignCreator.findUniqueOrThrow({ where: { id: other.creatorId } }),
      gift: await db.giftOrder.findUniqueOrThrow({ where: { id: other.giftId } }),
      influencer: await db.influencer.findUniqueOrThrow({ where: { id: other.influencerId } }),
      activity: await db.activity.count(),
    };
    await callAction(cookie, ids.get("updateCreatorStatus")!, [other.creatorId, "completed"]);
    await callAction(cookie, ids.get("decideGift")!, [other.giftId, "cancel"]);
    await callAction(cookie, ids.get("markDelivered")!, [other.giftId]);
    await callAction(cookie, ids.get("setInfluencerArchived")!, [other.influencerId, true]);
    const afterwards = {
      creator: await db.campaignCreator.findUniqueOrThrow({ where: { id: other.creatorId } }),
      gift: await db.giftOrder.findUniqueOrThrow({ where: { id: other.giftId } }),
      influencer: await db.influencer.findUniqueOrThrow({ where: { id: other.influencerId } }),
      activity: await db.activity.count(),
    };
    assert.equal(afterwards.creator.status, before.creator.status, "status unchanged by a forged call");
    assert.equal(afterwards.gift.status, before.gift.status, "gift unchanged by a forged call");
    assert.equal(afterwards.influencer.archived, false, "creator not archived by a forged call");
    assert.equal(afterwards.activity, before.activity, "no activity written by forged calls");

    // The same forged call against an own record does work, so the test is not passing by accident.
    await callAction(cookie, ids.get("updateCreatorStatus")!, [me.creatorId, "product_shipped"]);
    assert.equal((await db.campaignCreator.findUniqueOrThrow({ where: { id: me.creatorId } })).status, "product_shipped");

    console.log(`${mine} user, refused addresses:`, JSON.stringify(results));
  });
}
