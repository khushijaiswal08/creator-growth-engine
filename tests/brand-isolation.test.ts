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
 * attempt must come back 404 or 403 (401 for the scheduler) and leave the
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
  user: { email: string };
  campaignId: string;
  influencerId: string;
  profileId: string;
  creatorId: string;
  giftId: string;
  assetId: string;
  uploadToken: string;
  linkId: string;
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
    const profile = await db.socialProfile.findFirstOrThrow({ where: { influencerId: influencer.id } });
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
    // A file the creator sent through their upload link, and the link itself.
    const uploadToken = `${brand.replace(/-/g, "")}uploadtoken0123456789abcdef`;
    await db.campaignCreator.update({ where: { id: creator.id }, data: { uploadToken, uploadExpiresAt: new Date(Date.now() + 86_400_000) } });
    const asset = await db.contentAsset.create({
      data: {
        campaignCreatorId: creator.id,
        kind: "video",
        fileName: `${brand}-reel.mp4`,
        contentType: "video/mp4",
        sizeBytes: 1000,
        storageKey: `content/${brand}/${creator.id}/asset/${brand}-reel.mp4`,
        status: "received",
        usageRights: "paid",
        receivedAt: new Date(),
      },
    });
    // An Amazon tracking link with a day of numbers, so the Amazon report has something to show or hide.
    const link = await db.attributionLink.create({ data: { campaignCreatorId: creator.id, url: `https://www.amazon.com/dp/B0ISOLATION?maas=m_${brand}&ref_=aa_maas`, maas: `m_${brand}`, asin: "B0ISOLATION", adGroupName: `${brand}-adgroup`, addedById: user.id } });
    const reportImport = await db.reportImport.create({ data: { brandId: brand, kind: "attribution", fileName: `${brand}.csv`, periodStart: new Date(), periodEnd: new Date(), rows: 1, matched: 1, importedById: user.id } });
    await db.attributionStat.create({ data: { linkId: link.id, periodStart: new Date(Date.now() - 3 * 86_400_000), periodEnd: new Date(Date.now() - 3 * 86_400_000), clicks: brand === "ridhi" ? 111 : 222, purchases: 3, productSales: 99, importId: reportImport.id } });
    fixtures[brand] = { user, campaignId: campaign.id, influencerId: influencer.id, profileId: profile.id, creatorId: creator.id, giftId: gift.id, assetId: asset.id, uploadToken, linkId: link.id };
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
    assert.equal((await get(cookie, "/reports/outreach")).status, 200);
    assert.equal((await get(cookie, "/settings")).status, 200);
    assert.equal((await get(cookie, "/reports/performance")).status, 200);
    assert.equal((await get(cookie, "/influencers/ranking")).status, 200);
    assert.equal((await get(cookie, `/reports/outreach/export?campaign=${me.campaignId}`)).status, 200);
    assert.equal((await get(cookie, `/campaigns/${me.campaignId}?view=list`)).status, 200);
    assert.equal((await get(cookie, "/content")).status, 200);
    // The search box finds the own brand's creator and never the other brand's, though both are called "creator".
    const found = await (await get(cookie, "/search?q=creator")).text();
    assert.match(found, new RegExp(`${mine} creator`), "search lists the own brand's creator");
    assert.doesNotMatch(found, new RegExp(`${theirs} creator`), "search never lists the other brand's creator");
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
      "/admin/calibration",
      "/admin/tidy-up",
      `/reports/outreach/export?campaign=${other.campaignId}`,
      `/reports/performance/export?campaign=${other.campaignId}`,
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
    // The content library lists the own brand's files and never the other brand's.
    const library = await (await get(cookie, "/content?files=all")).text();
    assert.match(library, new RegExp(`${mine}-reel\\.mp4`), "the library lists the own brand's file");
    assert.doesNotMatch(library, new RegExp(`${theirs}-reel\\.mp4`), "the library never lists the other brand's file");
    // The Amazon report counts the own brand's links and never the other brand's.
    const amazon = await (await get(cookie, "/reports/amazon")).text();
    assert.match(amazon, new RegExp(`${mine} creator`), "the Amazon report lists the own brand's creator");
    assert.doesNotMatch(amazon, new RegExp(`${theirs} creator`), "the Amazon report never lists the other brand's creator");
    assert.doesNotMatch(amazon, new RegExp(theirs === "ridhi" ? ">111<" : ">222<"), "nor the other brand's clicks");
    // The test copy's local file store does not exist in a production build, signed address or not.
    assert.equal((await fetch(`${BASE}/api/content-store/content/${theirs}/x/asset/${theirs}-reel.mp4?m=GET&exp=9999999999&size=0&type=video%2Fmp4&dl=&sig=forged`)).status, 404);
    // Without bucket keys, a creator's upload link says uploads are not on yet instead of taking files.
    const uploadPage = await fetch(`${BASE}/upload/${other.uploadToken}`);
    assert.equal(uploadPage.status, 200);
    assert.match(await uploadPage.text(), /Uploads are not switched on yet/);

    // The public health check reveals nothing but up or down.
    assert.deepEqual(Object.keys(await (await fetch(`${BASE}/health`)).json()).sort(), ["database", "status"]);

    // Forged Server Actions against the other brand's records change nothing.
    const ids = actionIds();
    for (const name of ["updateCreatorStatus", "decideGift", "markDelivered", "setInfluencerArchived", "reviewContent", "archiveContent", "saveAttributionLink", "archiveAttributionLink", "uploadBusinessReport", "sendToAmazon", "previewForAmazon", "inviteBackToCampaign", "applyTidyUp", "undoTidy", "saveCreatorInsight", "refreshPublicNumbers", "deleteCampaign", "setCampaignArchived", "checkMarketplaceFieldsAction"]) {
      assert.ok(ids.has(name), `action id for ${name} found in the build`);
    }
    const before = {
      creator: await db.campaignCreator.findUniqueOrThrow({ where: { id: other.creatorId } }),
      gift: await db.giftOrder.findUniqueOrThrow({ where: { id: other.giftId } }),
      asset: await db.contentAsset.findUniqueOrThrow({ where: { id: other.assetId } }),
      otherSales: await db.productMonthlySales.count({ where: { brandId: theirs } }),
      activity: await db.activity.count(),
      links: await db.campaignCreator.count(),
      insights: await db.creatorInsight.count(),
      publicPosts: await db.profilePost.count(),
    };
    await callAction(cookie, ids.get("updateCreatorStatus")!, [other.creatorId, "completed"]);
    // Invite back: into the other brand's campaign, and the other brand's creator into an own campaign.
    await callAction(cookie, ids.get("inviteBackToCampaign")!, [other.campaignId, [me.influencerId, other.influencerId]]);
    await callAction(cookie, ids.get("inviteBackToCampaign")!, [me.campaignId, [other.influencerId]]);
    // The tidy-up is for admins only: a marketer's forged call parks nobody, in either brand, and opens no tidy-up.
    await callAction(cookie, ids.get("applyTidyUp")!, [{ days: 30, group: "selection", action: "park", ids: [other.creatorId, me.creatorId], tidyUpId: null }]);
    await callAction(cookie, ids.get("undoTidy")!, ["forged"]);
    await callAction(cookie, ids.get("saveAttributionLink")!, [other.creatorId, "https://www.amazon.com/dp/B0FORGED01?maas=m_forged&ref_=aa_maas", "forged"]);
    await callAction(cookie, ids.get("archiveAttributionLink")!, [other.linkId]);
    await callAction(cookie, ids.get("previewForAmazon")!, [other.giftId]);
    await callAction(cookie, ids.get("sendToAmazon")!, [other.giftId]);
    // A marketer naming the other brand still imports into their own: the account's brand wins.
    // (In the action wire format a leading "$" is escaped as "$$", as React's encodeReply does.)
    await callAction(cookie, ids.get("uploadBusinessReport")!, [{ brandId: theirs, rows: [["(Child) ASIN", "Units Ordered", "Ordered Product Sales"], ["B0FORGED01", "5", "$$50"]], fileName: "forged.csv", month: "2026-09" }]);
    await callAction(cookie, ids.get("reviewContent")!, [other.assetId, "approve", ""]);
    await callAction(cookie, ids.get("archiveContent")!, [other.assetId]);
    await callAction(cookie, ids.get("decideGift")!, [other.giftId, "cancel"]);
    await callAction(cookie, ids.get("markDelivered")!, [other.giftId]);
    await callAction(cookie, ids.get("setInfluencerArchived")!, [other.influencerId, true]);
    // Creator-supplied numbers and a refresh of public numbers aimed at the other brand's profile.
    await callAction(cookie, ids.get("saveCreatorInsight")!, [other.profileId, { reach7d: "100", reach30d: "9999", profileViews30d: "5", usAudiencePct: "50", evidence: "forged", note: "forged", asOf: "2026-10-01" }]);
    await callAction(cookie, ids.get("refreshPublicNumbers")!, [other.profileId]);
    // Deleting or archiving the other brand's campaign.
    await callAction(cookie, ids.get("deleteCampaign")!, [other.campaignId]);
    await callAction(cookie, ids.get("setCampaignArchived")!, [other.campaignId, true]);
    // The Creator Marketplace field check is for admins only.
    const fieldCheck = await callAction(cookie, ids.get("checkMarketplaceFieldsAction")!, []);
    assert.match(await fieldCheck.text(), /Only an admin can check the Creator Marketplace fields/);
    // A forged call with the wrong shape must not crash the action or write anything.
    await callAction(cookie, ids.get("saveCreatorInsight")!, [other.profileId, 12345]);
    const afterwards = {
      creator: await db.campaignCreator.findUniqueOrThrow({ where: { id: other.creatorId } }),
      gift: await db.giftOrder.findUniqueOrThrow({ where: { id: other.giftId } }),
      influencer: await db.influencer.findUniqueOrThrow({ where: { id: other.influencerId } }),
      asset: await db.contentAsset.findUniqueOrThrow({ where: { id: other.assetId } }),
      link: await db.attributionLink.findUniqueOrThrow({ where: { id: other.linkId } }),
      otherSales: await db.productMonthlySales.count({ where: { brandId: theirs } }),
      activity: await db.activity.count(),
      links: await db.campaignCreator.count(),
      insights: await db.creatorInsight.count(),
      publicPosts: await db.profilePost.count(),
    };
    assert.equal(afterwards.insights, before.insights, "no creator numbers saved on the other brand's profile by a forged call");
    assert.equal(afterwards.publicPosts, before.publicPosts, "no public posts written for the other brand's profile");
    assert.equal(afterwards.links, before.links, "nobody invited into or out of the other brand by a forged call");
    assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: other.campaignId } })).status, "active", "the other brand's campaign neither deleted nor archived by a forged call");
    assert.equal(await db.tidyUp.count(), 0, "no tidy-up opened by a marketer's forged call");
    assert.equal(await db.attributionLink.count({ where: { maas: "m_forged" } }), 0, "no link saved on the other brand's creator");
    assert.equal(afterwards.link.archived, false, "the other brand's link not removed by a forged call");
    assert.equal(afterwards.otherSales, before.otherSales, "nothing imported into the other brand");
    assert.equal(await db.productMonthlySales.count({ where: { brandId: mine, childAsin: "B0FORGED01" } }), 1, "the upload went to the own brand");
    await db.productMonthlySales.deleteMany({ where: { childAsin: "B0FORGED01" } });
    assert.equal(afterwards.asset.status, before.asset.status, "file not approved by a forged call");
    assert.equal(afterwards.asset.archived, false, "file not removed by a forged call");
    assert.equal(afterwards.creator.status, before.creator.status, "status unchanged by a forged call");
    assert.equal(afterwards.gift.status, before.gift.status, "gift unchanged by a forged call");
    assert.equal(afterwards.gift.mcfSentAt, null, "the other brand's gift not sent to Amazon by a forged call");
    assert.equal(afterwards.influencer.archived, false, "creator not archived by a forged call");
    // The one write that is allowed (the own-brand import) logs one line; nothing else did.
    assert.equal(afterwards.activity, before.activity + 1, "no activity written by forged calls");

    // A removed tag of the other brand cannot be taken over by saving it on an own creator: it stays with its creator and its history.
    await db.attributionLink.update({ where: { id: other.linkId }, data: { archived: true } });
    await callAction(cookie, ids.get("saveAttributionLink")!, [me.creatorId, `https://www.amazon.com/dp/B0ISOLATION?maas=m_${theirs}&ref_=aa_maas`, "takeover"]);
    const kept = await db.attributionLink.findUniqueOrThrow({ where: { id: other.linkId } });
    assert.equal(kept.campaignCreatorId, other.creatorId, "the other brand's removed tag stays with its creator");
    assert.equal(kept.archived, true);
    await db.attributionLink.update({ where: { id: other.linkId }, data: { archived: false } });

    // The same call against an own profile does work, so the test is not passing by accident.
    await callAction(cookie, ids.get("saveCreatorInsight")!, [me.profileId, { reach7d: "", reach30d: "12,400", profileViews30d: "", usAudiencePct: "84", evidence: "screenshot", note: "", asOf: "2026-10-20" }]);
    const ownInsight = await db.creatorInsight.findFirstOrThrow({ where: { socialProfileId: me.profileId } });
    const meUser = await db.user.findUniqueOrThrow({ where: { email: me.user.email } });
    assert.deepEqual([ownInsight.reach30d, ownInsight.usAudiencePct, ownInsight.addedById], [12_400, 84, meUser.id]);
    assert.equal(await db.creatorInsight.count({ where: { socialProfileId: other.profileId, evidence: "forged" } }), 0);

    // The same forged call against an own record does work, so the test is not passing by accident.
    await callAction(cookie, ids.get("updateCreatorStatus")!, [me.creatorId, "product_shipped"]);
    assert.equal((await db.campaignCreator.findUniqueOrThrow({ where: { id: me.creatorId } })).status, "product_shipped");

    console.log(`${mine} user, refused addresses:`, JSON.stringify(results));
  });
}
