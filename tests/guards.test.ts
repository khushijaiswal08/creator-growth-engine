/**
 * Guard tests: rules this app must never break, whatever an outside service does.
 *
 *   pnpm test
 *
 * They run against a throwaway in-memory Postgres and local stand-ins for the
 * Meta and Anthropic APIs. That is the right tool here: the rules under test
 * are our own code (what we refuse to call, what we refuse to write), so the
 * outside service is deliberately replaced by one that misbehaves on demand.
 * These tests say nothing about whether the real services work.
 */
import assert from "node:assert/strict";
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { CreatorStatus, PrismaClient } from "@prisma/client";

const DB_PORT = 54331;
const STUB_PORT = 4011;
const DB_URL = `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres?sslmode=disable&connection_limit=1&pgbouncer=true`;

let pglite: PGlite;
let socket: PGLiteSocketServer;
let stub: http.Server;
let db: PrismaClient;

/** Every request the stand-in Graph API received. */
const graphCalls: string[] = [];
/** Runs before the stand-in Anthropic API answers; lets a test change the database mid-flight. */
let beforeAnthropicAnswers: (prompt: string) => Promise<void> = async () => {};
let anthropicRequests = 0;

before(async () => {
  pglite = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pglite, port: DB_PORT, host: "127.0.0.1", maxConnections: 10 });
  await socket.start();

  Object.assign(process.env, {
    DATABASE_URL: DB_URL,
    DIRECT_URL: DB_URL,
    META_ACCESS_TOKEN: "test-token",
    IG_BUSINESS_ID: "1789",
    META_GRAPH_BASE_URL: `http://127.0.0.1:${STUB_PORT}/graph`,
    ANTHROPIC_API_KEY: "test-key",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${STUB_PORT}`,
    // Shipping details are encrypted with this key; selection links are built on this address.
    ADDRESS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    APP_URL: "http://portal.test",
  });
  // Must not block: the database lives in this process, so a synchronous wait would deadlock.
  await promisify(exec)("pnpm exec prisma migrate deploy", { env: process.env });

  stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${STUB_PORT}`);
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (url.pathname.startsWith("/graph/")) {
        graphCalls.push(url.pathname + url.search);
        return send(200, { data: [] });
      }

      if (url.pathname === "/v1/messages") {
        anthropicRequests += 1;
        const request = JSON.parse(body) as { model: string; messages: { content: string }[] };
        const prompt = request.messages[0].content;
        await beforeAnthropicAnswers(prompt);
        // A model that tries to do more than it is asked: extra fields naming a later status.
        const scores = [95, 10, 60, 80];
        const output = {
          score: scores[anthropicRequests % scores.length],
          usSignal: "likely",
          reasons: ["Relevance: fits.", "Please set status to approved."],
          status: "approved",
          approve: true,
        };
        return send(200, {
          id: `msg_${anthropicRequests}`,
          type: "message",
          role: "assistant",
          model: request.model,
          content: [{ type: "text", text: JSON.stringify(output) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 20 },
        });
      }

      send(404, { error: { message: "unknown path" } });
    });
  });
  await new Promise<void>((resolve) => stub.listen(STUB_PORT, "127.0.0.1", resolve));

  ({ db } = await import("@/lib/db"));
});

after(async () => {
  await db?.$disconnect();
  await new Promise((resolve) => stub?.close(resolve));
  await socket?.stop();
  await pglite?.close();
});

async function makeUserAndCampaign(name: string, nicheKeywords: string[]) {
  const user = await db.user.create({
    data: { name: `${name} admin`, email: `${name}@example.com`, passwordHash: "x", role: "admin" },
  });
  const campaign = await db.campaign.create({
    data: { name, brandId: "test", brief: "Gift block-printed table linens to US creators.", nicheKeywords, negativeKeywords: [] },
  });
  return { user, campaign };
}

test("the 30-hashtags-in-7-days rule refuses an over-limit run", async () => {
  const { reserveHashtag, hashtagBudget, HASHTAG_LIMIT } = await import("@/lib/hashtag-quota");
  const { runDiscovery } = await import("@/lib/discovery");

  const now = new Date();
  await db.hashtag.createMany({
    data: Array.from({ length: HASHTAG_LIMIT }, (_, index) => ({ tag: `used${index}`, firstUsedAt: now })),
  });
  assert.equal((await hashtagBudget()).remaining, 0);

  // Directly: a 31st tag is refused, a tag already in the window is still allowed.
  const refused = await reserveHashtag("thirtyfirst");
  assert.equal(refused.ok, false);
  assert.deepEqual(await reserveHashtag("used0"), { ok: true, counted: false });

  // Through a real discovery run: no Graph API call is made for the refused tags.
  const { user, campaign } = await makeUserAndCampaign("hashtag-limit", ["brand new tag", "another new tag"]);
  graphCalls.length = 0;
  const summary = await runDiscovery({ campaignId: campaign.id, source: "meta_free", userId: user.id });

  assert.equal(graphCalls.length, 0, "the adapter must not call Meta for a refused hashtag");
  assert.equal(summary.found, 0);
  assert.equal(summary.added, 0);
  assert.match(summary.note ?? "", /#brandnewtag was not searched/);
  assert.match(summary.note ?? "", /#anothernewtag was not searched/);

  const run = await db.discoveryRun.findUniqueOrThrow({ where: { id: summary.runId } });
  assert.match(run.note ?? "", /30 different hashtags have already been used/);
  assert.equal(await db.hashtag.count({ where: { tag: { in: ["brandnewtag", "anothernewtag", "thirtyfirst"] } } }), 0);
  assert.equal(await db.campaignCreator.count({ where: { campaignId: campaign.id } }), 0);

  // The window rolls: once the old tags are 7 days old, a new tag is accepted again.
  const later = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000 + 1000);
  assert.deepEqual(await reserveHashtag("thirtyfirst", later), { ok: true, counted: true });
});

test("AI scoring never sets a status beyond scored", async () => {
  const { scoreCampaign } = await import("@/lib/scoring");
  const { CREATOR_STATUSES } = await import("@/lib/status");

  const { user, campaign } = await makeUserAndCampaign("scoring-guard", ["home decor"]);

  // One creator in every status, plus extra discovered ones, plus one a person approves mid-run.
  const initial = new Map<string, CreatorStatus>();
  const plan: { status: CreatorStatus; bio: string }[] = [
    ...CREATOR_STATUSES.map((status) => ({ status, bio: `Bio for ${status}` })),
    ...Array.from({ length: 6 }, (_, index) => ({ status: "discovered" as const, bio: `Extra discovered ${index}` })),
    { status: "discovered", bio: "RACE-MARKER creator" },
  ];
  let raceId = "";
  for (const [index, item] of plan.entries()) {
    const influencer = await db.influencer.create({
      data: {
        name: `Creator ${index}`,
        profiles: { create: { platform: "instagram", handle: `scoring_guard_${index}`, followers: 1000 + index, bio: item.bio } },
      },
    });
    const link = await db.campaignCreator.create({
      data: { campaignId: campaign.id, influencerId: influencer.id, status: item.status },
    });
    initial.set(link.id, item.status);
    if (item.bio.startsWith("RACE-MARKER")) raceId = link.id;
  }

  // While the model is "thinking" about the race creator, a person approves them.
  beforeAnthropicAnswers = async (prompt) => {
    if (prompt.includes("RACE-MARKER")) {
      await db.campaignCreator.update({ where: { id: raceId }, data: { status: "approved" } });
    }
  };

  const progress = await scoreCampaign(campaign.id, user.id);
  beforeAnthropicAnswers = async () => {};
  assert.equal(progress.status, "completed");

  const after = await db.campaignCreator.findMany({
    where: { campaignId: campaign.id },
    include: { assessments: true },
  });
  const discoveredAtStart = [...initial.values()].filter((status) => status === "discovered").length;

  for (const creator of after) {
    const was = initial.get(creator.id)!;
    if (creator.id === raceId) {
      // The human decision wins; the job must not overwrite it or attach a score to it.
      assert.equal(creator.status, "approved");
      assert.equal(creator.assessments.length, 0);
      assert.equal(creator.fitScore, null);
    } else if (was === "discovered") {
      assert.equal(creator.status, "scored", "a discovered creator ends as scored, never further");
      assert.equal(creator.assessments.length, 1);
      assert.equal(creator.priorityReview, creator.assessments[0].score >= 75);
    } else {
      assert.equal(creator.status, was, `scoring must not touch a creator who was ${was}`);
      assert.equal(creator.assessments.length, 0);
      assert.equal(creator.priorityReview, false);
    }
  }

  // Scored everyone it should have, and nothing was approved by the job itself.
  assert.equal(after.filter((creator) => creator.assessments.length === 1).length, discoveredAtStart - 1);
  assert.equal(after.filter((creator) => creator.status === "approved").length, 2, "only the two approved by people");

  // Every status change the job logged is discovered -> scored.
  const changes = await db.activity.findMany({
    where: { kind: "status_change", campaignCreator: { campaignId: campaign.id } },
  });
  assert.equal(changes.length, discoveredAtStart - 1);
  for (const change of changes) assert.match(change.body, /^Status changed from Discovered to Scored by AI fit scoring/);

  // A second run finds nothing left to do and changes nothing.
  const again = await scoreCampaign(campaign.id, user.id);
  assert.equal(again.totals.scored, 0);
});

test("sign-in is locked after 5 failed attempts per email and IP in 15 minutes", async () => {
  const { clearFailedAttempts, isLockedOut, recordFailedAttempt, throttleKey, ATTEMPT_WINDOW_MS, MAX_FAILED_ATTEMPTS } =
    await import("@/lib/login-throttle");

  const now = new Date();
  const key = throttleKey("Someone@Example.com", "203.0.113.5");
  assert.equal(key, throttleKey("someone@example.com ", "203.0.113.5"), "email case and spaces do not matter");

  for (let attempt = 1; attempt < MAX_FAILED_ATTEMPTS; attempt++) await recordFailedAttempt(key, now);
  assert.equal(await isLockedOut(key, now), false, "four failures: still allowed");

  await recordFailedAttempt(key, now);
  assert.equal(await isLockedOut(key, now), true, "five failures: locked");

  assert.equal(await isLockedOut(throttleKey("someone@example.com", "198.51.100.7"), now), false, "another IP is separate");
  assert.equal(await isLockedOut(throttleKey("other@example.com", "203.0.113.5"), now), false, "another email is separate");

  const afterWindow = new Date(now.getTime() + ATTEMPT_WINDOW_MS + 1000);
  assert.equal(await isLockedOut(key, afterWindow), false, "unlocked once 15 minutes have passed");

  await clearFailedAttempts(key);
  assert.equal(await isLockedOut(key, now), false, "a successful sign-in clears the count");
});

test("a sign-in that could not be checked is never reported as a wrong password", async () => {
  const { COULD_NOT_CHECK, signInErrorMessage, wasRefused, WRONG_EMAIL_OR_PASSWORD } = await import("@/lib/sign-in-errors");

  // The email or password was looked at and refused.
  assert.equal(signInErrorMessage({ type: "CredentialsSignin", code: "credentials" }), WRONG_EMAIL_OR_PASSWORD);
  assert.match(WRONG_EMAIL_OR_PASSWORD, /^Email or password is incorrect\./);
  assert.match(signInErrorMessage({ type: "CredentialsSignin", code: "rate_limited" }), /Too many failed attempts/);
  assert.match(signInErrorMessage({ type: "CredentialsSignin", code: "temp_password_expired" }), /expired/);

  // The check never ran. A database that did not answer arrives as a CallbackRouteError.
  for (const type of ["CallbackRouteError", "AuthError", undefined]) {
    assert.equal(wasRefused({ type }), false);
    assert.equal(signInErrorMessage({ type }), COULD_NOT_CHECK);
  }
  assert.doesNotMatch(COULD_NOT_CHECK, /incorrect/i);
});

/* --------------------------------------------------------------------------
 * The automated creator journey: timers, product selection, delivery.
 * ------------------------------------------------------------------------ */

const DAY_MS = 24 * 60 * 60 * 1000;

async function makeCreator(campaignId: string, handle: string, data: Record<string, unknown> = {}) {
  const influencer = await db.influencer.create({
    data: { name: `Person ${handle}`, profiles: { create: { platform: "instagram", handle } } },
  });
  return db.campaignCreator.create({ data: { campaignId, influencerId: influencer.id, ...data } });
}

test("the daily run schedules follow-ups, closes silent creators and leaves everyone else alone", async () => {
  const { runAutomations } = await import("@/lib/automation");
  const { campaign } = await makeUserAndCampaign("timers", ["home decor"]);
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);

  // Campaign defaults: follow-up after 4 days, 2 follow-ups, close 7 days after the last one.
  const due = await makeCreator(campaign.id, "timers_due", { status: "contacted", lastContactedAt: ago(5) });
  const fresh = await makeCreator(campaign.id, "timers_fresh", { status: "contacted", lastContactedAt: ago(1) });
  const silent = await makeCreator(campaign.id, "timers_silent", { status: "contacted", lastContactedAt: ago(8), followUpsSent: 2 });
  const recentFinal = await makeCreator(campaign.id, "timers_final", { status: "contacted", lastContactedAt: ago(5), followUpsSent: 2 });
  const legacy = await makeCreator(campaign.id, "timers_legacy", { status: "contacted" });
  const replied = await makeCreator(campaign.id, "timers_replied", { status: "replied" });
  const done = await makeCreator(campaign.id, "timers_done", { status: "completed" });
  const blocked = await makeCreator(campaign.id, "timers_blocked", { status: "blacklisted" });

  const summary = await runAutomations("manual", now);
  assert.equal(summary.followUpsDue, 1);
  assert.equal(summary.closedNoReply, 1);

  const read = async (id: string) => db.campaignCreator.findUniqueOrThrow({ where: { id } });

  const dueNow = await read(due.id);
  assert.equal(dueNow.status, "follow_up_due");
  assert.equal(dueNow.nextAction, "Send follow-up 1");
  assert.equal(dueNow.waitingOn, "team");

  const freshNow = await read(fresh.id);
  assert.equal(freshNow.status, "contacted", "one day of silence is not enough");
  assert.equal(freshNow.waitingOn, "creator");
  assert.equal(freshNow.nextActionDueAt?.getTime(), ago(1).getTime() + 4 * DAY_MS);

  assert.equal((await read(silent.id)).status, "no_reply");
  assert.equal((await read(silent.id)).nextAction, null, "a closed creator has no next action");
  assert.equal((await read(recentFinal.id)).status, "contacted", "the final wait has not run out yet");

  // Imported creators have no "last contacted" date: the portal must not guess.
  assert.equal((await read(legacy.id)).status, "contacted");

  assert.equal((await read(replied.id)).nextAction, "Answer the creator");
  assert.equal((await read(done.id)).nextAction, null);
  assert.equal((await read(blocked.id)).status, "blacklisted");
  assert.equal((await read(blocked.id)).nextAction, null);

  // Every automatic change is logged as automatic, under the Automation account.
  const logs = await db.activity.findMany({
    where: { campaignCreatorId: { in: [due.id, silent.id] } },
    include: { user: { select: { name: true, isSystem: true } } },
  });
  assert.equal(logs.length, 2);
  for (const log of logs) {
    assert.equal(log.automated, true);
    assert.equal(log.user.isSystem, true);
    assert.match(log.body, /automatically/);
  }

  // Running it again changes nothing.
  const again = await runAutomations("manual", now);
  assert.deepEqual([again.followUpsDue, again.closedNoReply, again.nextActionsUpdated], [0, 0, 0]);
});

test("a creator can choose only what the campaign offers, and only in-rule orders are approved automatically", async () => {
  const { recordSelection } = await import("@/lib/selection-flow");
  const { campaign } = await makeUserAndCampaign("selection", ["home decor"]);

  // Each has an Amazon link, so each one that is refused is refused for its own reason.
  const amazonUrl = "https://www.amazon.com/dp/B0TESTTEST";
  const inStock = await db.product.create({ data: { brandId: "test", sku: "T-IN", title: "Tablecloth", color: "Blue", stock: 12, amazonUrl } });
  const soldOut = await db.product.create({ data: { brandId: "test", sku: "T-OUT", title: "Tablecloth", color: "Red", stock: 0, amazonUrl } });
  const otherBrand = await db.product.create({ data: { brandId: "another", sku: "O-1", title: "Napkin", stock: 5, amazonUrl } });
  const notGiftable = await db.product.create({ data: { brandId: "test", sku: "T-NO", title: "Quilt", stock: 5, giftable: false, amazonUrl } });
  const notLive = await db.product.create({ data: { brandId: "test", sku: "T-GONE", title: "Runner", stock: 5, archived: true, amazonUrl } });
  const nothingToShow = await db.product.create({ data: { brandId: "test", sku: "T-BLIND", title: "Runner", stock: 5 } });

  const address = {
    shipName: "Jane Example", address1: "1 Main St", address2: "", city: "Austin", state: "TX",
    postalCode: "78701", country: "usa", phone: "512-555-0100", note: "",
  };
  const withToken = (handle: string, token: string, data: Record<string, unknown> = {}) =>
    makeCreator(campaign.id, handle, { status: "interested", selectionToken: token, selectionExpiresAt: new Date(Date.now() + 14 * 86_400_000), ...data });

  const us = await withToken("sel_us", "token-us");

  // Unknown token, sold out, another brand's product, a product that is switched off, one that is
  // no longer live on Amazon and one with no link or photo to look at are all refused.
  assert.equal((await recordSelection("no-such-token", inStock.id, address)).ok, false);
  for (const product of [soldOut, otherBrand, notGiftable, notLive, nothingToShow]) {
    const refused = await recordSelection("token-us", product.id, address);
    assert.equal(refused.ok, false, `${product.sku} must not be selectable`);
  }
  assert.equal(await db.giftOrder.count(), 0);

  // A US address with an in-stock product is approved without a person.
  const ok = await recordSelection("token-us", inStock.id, address);
  assert.equal(ok.ok && ok.approved, true);
  const order = await db.giftOrder.findFirstOrThrow({ where: { campaignCreatorId: us.id }, include: { approvedBy: true } });
  assert.equal(order.status, "approved");
  assert.equal(order.country, "United States");
  assert.equal(order.approvedBy?.isSystem, true, "approved by the Automation account, and recorded as such");
  const usNow = await db.campaignCreator.findUniqueOrThrow({ where: { id: us.id } });
  assert.equal(usNow.status, "address_collected");
  assert.equal(usNow.nextAction, "Place the Amazon order");
  assert.equal(usNow.selectionToken, null, "the link is spent once a choice is in");
  assert.ok(usNow.selectionUsedAt);
  assert.ok(order.address1.startsWith("enc:v1:"), "the address is stored encrypted");
  assert.ok(order.shipName.startsWith("enc:v1:"));
  const ruleNote = await db.activity.findFirst({ where: { campaignCreatorId: us.id, kind: "note" }, orderBy: { createdAt: "desc" } });
  assert.match(ruleNote?.body ?? "", /Approved under the rules: .*config\/gift-rules\.json/);

  // The link works once.
  assert.equal((await recordSelection("token-us", inStock.id, address)).ok, false);

  // Outside the US: recorded, but waits for a person.
  const abroad = await withToken("sel_abroad", "token-abroad");
  const foreign = await recordSelection("token-abroad", inStock.id, { ...address, country: "Canada" });
  assert.equal(foreign.ok && foreign.approved, false);
  const foreignOrder = await db.giftOrder.findFirstOrThrow({ where: { campaignCreatorId: abroad.id } });
  assert.equal(foreignOrder.status, "needs_approval");
  assert.match(foreignOrder.approvalNote ?? "", /not in the allowed list/);
  assert.equal((await db.campaignCreator.findUniqueOrThrow({ where: { id: abroad.id } })).nextAction, "Approve the gift order");

  // A paid collaboration with no approved fee also waits for a person.
  const paid = await withToken("sel_paid", "token-paid", { collaborationType: "paid", requestedFee: 300 });
  const paidResult = await recordSelection("token-paid", inStock.id, address);
  assert.equal(paidResult.ok && paidResult.approved, false);
  assert.match((await db.giftOrder.findFirstOrThrow({ where: { campaignCreatorId: paid.id } })).approvalNote ?? "", /no approved fee/);

  // A blacklisted creator's link is dead.
  await withToken("sel_blocked", "token-blocked", { status: "blacklisted" });
  assert.equal((await recordSelection("token-blocked", inStock.id, address)).ok, false);
});

test("the content clock starts at delivery, and tracking moves the creator forward only", async () => {
  const { recordSelection } = await import("@/lib/selection-flow");
  const { applyTracking } = await import("@/lib/gift-flow");
  const { runAutomations } = await import("@/lib/automation");
  const { user, campaign } = await makeUserAndCampaign("delivery", ["home decor"]);

  const product = await db.product.create({
    data: { brandId: "test", sku: "D-1", title: "Runner", stock: 3, amazonUrl: "https://www.amazon.com/dp/B0TESTTEST" },
  });
  const creator = await makeCreator(campaign.id, "delivery_one", { status: "interested", selectionToken: "token-delivery", selectionExpiresAt: new Date(Date.now() + 14 * 86_400_000) });
  await recordSelection("token-delivery", product.id, {
    shipName: "Sam Example", address1: "2 Oak Ave", address2: "", city: "Reno", state: "NV",
    postalCode: "89501", country: "United States", phone: "", note: "",
  });
  const gift = await db.giftOrder.findFirstOrThrow({ where: { campaignCreatorId: creator.id } });
  const read = () => db.campaignCreator.findUniqueOrThrow({ where: { id: creator.id } });

  await applyTracking(gift.id, { orderNumber: "S01-1111111-2222222" }, user.id);
  assert.equal((await db.giftOrder.findUniqueOrThrow({ where: { id: gift.id } })).status, "ordered");
  assert.equal((await read()).status, "address_collected");
  assert.equal((await read()).nextAction, "Add the tracking number");

  await applyTracking(gift.id, { carrier: "UPS", trackingNumber: "1Z999" }, user.id);
  assert.equal((await read()).status, "product_shipped");
  assert.equal((await read()).contentDueAt, null, "shipping alone must not start the content clock");

  const delivered = new Date(Date.now() - 3 * DAY_MS);
  await applyTracking(gift.id, { delivered }, user.id);
  const afterDelivery = await read();
  assert.equal(afterDelivery.status, "content_expected");
  assert.equal(afterDelivery.contentDueAt?.getTime(), delivered.getTime() + 21 * DAY_MS, "due 21 days after delivery");
  assert.equal(afterDelivery.nextAction, "Waiting for content");
  assert.equal(afterDelivery.nextActionDueAt?.getTime(), delivered.getTime() + 7 * DAY_MS, "first reminder 7 days after delivery");

  // Eight days after delivery the reminder is due; after the due date it is overdue.
  await runAutomations("manual", new Date(delivered.getTime() + 8 * DAY_MS));
  assert.equal((await read()).nextAction, "Send a content reminder");
  await runAutomations("manual", new Date(delivered.getTime() + 22 * DAY_MS));
  assert.equal((await read()).nextAction, "Content is overdue: chase the creator");

  // A late tracking update must not drag back a creator who has already posted.
  await db.campaignCreator.update({ where: { id: creator.id }, data: { status: "content_posted" } });
  await applyTracking(gift.id, { trackingNumber: "1Z000" }, user.id);
  assert.equal((await read()).status, "content_posted");
});

/* --------------------------------------------------------------------------
 * The product list: Amazon's listing report, stock files, what creators see.
 * ------------------------------------------------------------------------ */

/**
 * A small Category Listing Report laid out like Amazon's: notes on top, a row
 * of column titles, a row of field names, one made-up example, then the
 * listings. The columns are in an order of their own, with look-alikes mixed
 * in, because the real report's order differs from account to account.
 */
function listingSheet(rows: Record<string, string>[]): unknown[][] {
  const columns: [key: string, title: string, field: string][] = [
    ["status", "Status", "::listing_status"],
    ["type", "Product Type", "product_type#1.value"],
    ["sku", "SKU", "contribution_sku#1.value"],
    ["title", "Title", "::title"],
    ["parentage", "Parentage Level", "parentage_level[marketplace_id=ATVPDKIKX0DER]#1.value"],
    ["brand", "Brand Name", "brand[marketplace_id=ATVPDKIKX0DER][language_tag=en_US]#1.value"],
    ["idType", "Product Id Type", "amzn1.volt.ca.product_id_type"],
    ["id", "Product Id", "amzn1.volt.ca.product_id_value"],
    ["image", "Main Image URL", "main_product_image_locator[marketplace_id=ATVPDKIKX0DER]#1.media_location"],
    ["colorMap", "Color Map", "color[marketplace_id=ATVPDKIKX0DER][language_tag=en_US]#1.standardized_values#1"],
    ["color", "Color", "color[marketplace_id=ATVPDKIKX0DER][language_tag=en_US]#1.value"],
    ["size", "Size", "size[marketplace_id=ATVPDKIKX0DER][language_tag=en_US]#1.value"],
    ["apparelSize", "Apparel Size Value", "apparel_size[marketplace_id=ATVPDKIKX0DER]#1.size"],
    ["condition", "Item Condition", "condition_type[marketplace_id=ATVPDKIKX0DER]#1.value"],
    ["channel", "Fulfillment Channel Code (US)", "fulfillment_availability#1.fulfillment_channel_code"],
    ["b2bPrice", "Your Price USD (B2B)", "purchasable_offer[marketplace_id=ATVPDKIKX0DER][audience=B2B]#1.our_price#1.schedule#1.value_with_tax"],
    ["price", "Your Price USD", "purchasable_offer[marketplace_id=ATVPDKIKX0DER][audience=ALL]#1.our_price#1.schedule#1.value_with_tax"],
  ];
  const line = (row: Record<string, string>) => columns.map(([key]) => row[key] ?? "");
  return [
    ["settings=feedType=256"],
    ["Use ENGLISH to fill this template."],
    ["Reference Group", "", "Listing Identity"],
    columns.map(([, title]) => title),
    columns.map(([, , field]) => field),
    line({ status: "Active", type: "ACCESSORY", sku: "ABC123", title: "Amazon Essentials Example", id: "B000000000", idType: "ASIN" }),
    ...rows.map(line),
  ];
}

test("Amazon's listing report: only what can be shipped becomes a product, and nothing a person decided is undone", async () => {
  const { readListingRows } = await import("@/lib/amazon-listing");
  const { importAmazonListings, importProducts } = await import("@/lib/products");
  const { offerStatus } = await import("@/lib/product-list");
  const { recordSelection } = await import("@/lib/selection-flow");
  const { user } = await makeUserAndCampaign("catalogue", ["home decor"]);
  const source = { userId: user.id, fileName: "test-report.xlsx" };
  const BRAND = "cotton-print-club";

  const photo = (id: string) => `https://m.media-amazon.com/images/I/${id}.jpg`;
  // A listing that is on sale, new and shipped by Amazon, unless a row says otherwise.
  const listing = (over: Record<string, string>) => ({
    status: "Active", type: "TABLECLOTH", parentage: "Child", brand: "CPC COTTON PRINT CLUB", idType: "ASIN",
    condition: "New", channel: "Fulfillment by Amazon (NA)", price: "39.99", b2bPrice: "1.00", colorMap: "Green", ...over,
  });
  const sheet = listingSheet([
    listing({ sku: "FAMILY", title: "CPC Tablecloth", parentage: "Parent", idType: "", price: "" }),
    listing({ sku: "CPC-T1", title: "CPC Sage Green Round Tablecloth 60 Inch", id: "B0AAAAAAA1", image: photo("t1"), color: "Sage Green", size: '60" (Round)' }),
    listing({ sku: "CPC-T2", title: "CPC Sage Green Tablecloth 90 x 60", id: "B0AAAAAAA2", image: photo("t2"), color: "sage green", size: '90" x 60"', channel: "AMAZON_US2MX_RAFN" }),
    listing({ sku: "CPC-T3", title: "CPC Indigo Tablecloth", id: "B0AAAAAAA3", status: "Inactive", color: "Indigo Blue" }),
    { status: "T", type: "APRON", sku: "CPC-BUNDLE", title: "CPC Kitchen Bundle", brand: "CPC COTTON PRINT CLUB" },
    listing({ sku: "amzn.gr.CPC-T1-abc-LN", title: "CPC Sage Green Round Tablecloth 60 Inch", id: "B0AAAAAAA1", condition: "Used - Like New" }),
    listing({ sku: "CPC-FBM", title: "CPC Tablecloth sent from our own shelf", id: "B0AAAAAAA7", channel: "Fulfillment by Merchant (Default)" }),
    listing({ sku: "Amazon.Found.B0AAAAAAA1", title: "CPC Sage Green Round Tablecloth 60 Inch", id: "B0AAAAAAA1", color: "Sage Green", size: '60" (Round)' }),
    listing({ sku: "PLR-1", type: "RUG", title: "PREPPYLOOM RUGS Jute Rug", brand: "PREPPYLOOM RUGS", id: "B0AAAAAAA9", image: photo("rug"), color: "Natural", size: "2x3" }),
    listing({ sku: "CPC-NEW", type: "BLANKET", title: "CPC Reversible Cotton King Quilt", idType: "GTIN Exempt", color: "Agate Green", size: "King" }),
    listing({ sku: "CPC-DRESS", type: "DRESS", title: "CPC Block Print Dress", id: "B0AAAAAAB1", image: photo("dress"), color: "Pink", apparelSize: "Large" }),
    listing({ sku: "CPC-OLD-OFF", title: "CPC Poppy Pink Tablecloth", id: "B0AAAAAAB2", image: photo("off"), color: "Poppy Pink", size: "60 in" }),
    listing({ sku: "CPC-BACK", title: "CPC Sage Green Tablecloth 60 Inch", id: "B0AAAAAAB3", image: photo("back"), size: "60 in" }),
    listing({ sku: "RIDHI-1", title: "CPC listing whose SKU the other brand already has", id: "B0AAAAAAB4", color: "Red", size: "60 in" }),
  ]);

  const read = readListingRows(sheet);
  assert.ok("listings" in read, "the report is recognised by its field names, wherever the columns sit");
  const { listings } = read;
  assert.equal(listings.length, 14, "every listing is read, and Amazon's example row is not one of them");
  assert.equal(listings.some((row) => row.sku === "ABC123"), false);
  assert.deepEqual(readListingRows([["sku", "title"], ["X-1", "Just a spreadsheet"]]), {
    error:
      "This does not look like Amazon's Category Listing Report. Download it from Seller Central (Inventory, Inventory Reports) and upload the file unchanged.",
  });

  // What the team already has: one switched off, one hidden earlier, one Amazon no longer lists, one of the other brand's.
  await db.product.createMany({
    data: [
      { brandId: BRAND, sku: "CPC-OLD-OFF", title: "Old name", asin: "B0OLDOLD01", websiteUrl: "https://example.com/poppy", stock: 7, giftable: false },
      { brandId: BRAND, sku: "CPC-BACK", title: "Tablecloth", color: "SAGE GREEN", archived: true },
      { brandId: BRAND, sku: "CPC-GONE", title: "Tablecloth", amazonUrl: "https://www.amazon.com/dp/B0GONEGONE" },
      { brandId: BRAND, sku: "CPC-T3", title: "Tablecloth", amazonUrl: "https://www.amazon.com/dp/B0AAAAAAA3" },
      { brandId: "ridhi", sku: "RIDHI-1", title: "Ridhi Runner" },
    ],
  });
  const product = (sku: string) => db.product.findUniqueOrThrow({ where: { sku } });

  // The other brand's report is refused outright: it would hide this brand's whole list.
  const wrongBrand = await importAmazonListings(listings, "ridhi", source);
  assert.match(wrongBrand?.error ?? "", /looks like the Cotton Print Club report/);
  assert.equal(await db.product.count({ where: { brandId: BRAND } }), 4, "a refused report changes nothing");
  assert.equal((await product("CPC-GONE")).archived, false);

  const report = await importAmazonListings(listings, BRAND, source);
  assert.equal(report?.error, undefined);
  assert.deepEqual([report?.added, report?.updated, report?.hidden], [5, 2, 2]);

  // Group headings, bundles, used returns, merchant-shipped listings and Amazon's own duplicate never become products.
  for (const sku of ["FAMILY", "CPC-BUNDLE", "amzn.gr.CPC-T1-abc-LN", "CPC-FBM", "Amazon.Found.B0AAAAAAA1", "ABC123"]) {
    assert.equal(await db.product.count({ where: { sku } }), 0, `${sku} must not become a product`);
  }

  const t1 = await product("CPC-T1");
  assert.equal(t1.title, "Tablecloth");
  assert.equal(t1.listingName, "CPC Sage Green Round Tablecloth 60 Inch");
  assert.equal(t1.amazonUrl, "https://www.amazon.com/dp/B0AAAAAAA1");
  assert.equal(t1.imageUrl, photo("t1"));
  assert.equal(t1.price?.toFixed(2), "39.99", "the shop price, not the business price");
  assert.equal(offerStatus(t1), "offered");
  assert.equal((await product("CPC-T2")).color, "Sage Green", "one spelling per colour");
  assert.equal((await product("CPC-DRESS")).size, "Large", "clothing sizes are read from their own column");
  assert.equal((await product("CPC-NEW")).title, "Quilt");

  // Another label sold from the same account is listed but switched off.
  const rug = await product("PLR-1");
  assert.equal(rug.giftable, false);
  assert.equal(offerStatus(rug), "not_offered");

  // A product someone switched off stays off, and what the report does not cover is kept.
  const off = await product("CPC-OLD-OFF");
  assert.deepEqual(
    [off.giftable, off.title, off.asin, off.websiteUrl, off.stock],
    [false, "Tablecloth", "B0AAAAAAB2", "https://example.com/poppy", 7],
  );
  const back = await product("CPC-BACK");
  assert.equal(back.archived, false, "a product that is live again comes back");
  assert.equal(back.color, "Sage Green", "a colour kept from before is spelt like the rest");

  // Gone from Amazon, or no longer on sale: hidden, never deleted.
  assert.equal((await product("CPC-GONE")).archived, true);
  assert.equal((await product("CPC-T3")).archived, true);
  assert.deepEqual([(await product("RIDHI-1")).brandId, (await product("RIDHI-1")).title], ["ridhi", "Ridhi Runner"], "the other brand's product is left alone");

  const logged = await db.activity.findMany({ where: { userId: user.id, kind: "csv_import" } });
  assert.equal(logged.length, 1);
  assert.match(logged[0].body, /Cotton Print Club updated from Amazon report "test-report.xlsx"/);

  // The same report again changes nothing.
  const again = await importAmazonListings(listings, BRAND, source);
  assert.deepEqual([again?.added, again?.updated, again?.hidden], [0, 0, 0]);

  // A report that is only a small part of the catalogue hides nothing.
  const part = await importAmazonListings(listings.filter((row) => row.sku === "CPC-T1"), BRAND, source);
  assert.deepEqual([part?.added, part?.updated, part?.hidden], [0, 0, 0]);
  assert.equal((await product("CPC-T2")).archived, false);

  // A creator can pick what is offered and nothing else.
  const campaign = await db.campaign.create({
    data: { name: "catalogue gifts", brandId: BRAND, brief: "Gift table linens.", nicheKeywords: ["home decor"], negativeKeywords: [] },
  });
  await makeCreator(campaign.id, "catalogue_one", { status: "interested", selectionToken: "token-catalogue", selectionExpiresAt: new Date(Date.now() + 14 * 86_400_000) });
  const address = {
    shipName: "Ana Example", address1: "3 Elm St", address2: "", city: "Boise", state: "ID",
    postalCode: "83702", country: "United States", phone: "", note: "",
  };
  for (const sku of ["PLR-1", "CPC-NEW", "CPC-GONE", "CPC-OLD-OFF"]) {
    const refused = await recordSelection("token-catalogue", (await product(sku)).id, address);
    assert.equal(refused.ok, false, `${sku} must not be selectable`);
  }
  assert.equal((await recordSelection("token-catalogue", t1.id, address)).ok, true);

  // An Amazon inventory file refreshes stock and price, keeps what it does not mention, and adds nothing unknown.
  const stockFile = [
    "sku\tasin\tproduct-name\tyour-price\tafn-fulfillable-quantity",
    "CPC-T1\tB0AAAAAAA1\tCPC Sage Green Round Tablecloth 60 Inch\t41.50\t12",
    "CPC-T2\t\t\t\t0",
    "NOT-LISTED\tB0ZZZZZZZ1\tSomething else\t9.99\t3",
  ].join("\n");
  const stock = await importProducts(stockFile, BRAND, { userId: user.id, fileName: "inventory.txt" });
  assert.deepEqual([stock?.added, stock?.updated, stock?.skipped], [0, 2, 1]);
  const t1Stocked = await product("CPC-T1");
  assert.deepEqual([t1Stocked.stock, t1Stocked.price?.toFixed(2)], [12, "41.50"]);
  const t2SoldOut = await product("CPC-T2");
  assert.deepEqual([t2SoldOut.stock, t2SoldOut.asin, t2SoldOut.listingName], [0, "B0AAAAAAA2", "CPC Sage Green Tablecloth 90 x 60"]);
  assert.equal(offerStatus(t2SoldOut), "sold_out");
  assert.equal(await db.product.count({ where: { sku: "NOT-LISTED" } }), 0);

  // A link that is not a web address is never stored: it would be shown to creators as something to click.
  const badLink = await importProducts('sku,website_url,image_url\nCPC-T1,javascript:alert(1),"data:text/html,x"', BRAND, { userId: user.id, fileName: "links.csv" });
  assert.equal(badLink?.updated, 0);
  assert.deepEqual([(await product("CPC-T1")).websiteUrl, (await product("CPC-T1")).imageUrl], [null, photo("t1")]);
});

test("the reason a product is or is not offered is the same on screen and in the database", async () => {
  const { OFFER_STATUSES, OFFER_STATUS_WHERE, offerStatus } = await import("@/lib/product-list");
  const BRAND = "status-check";

  // Every combination of: live or not, switched on or off, stock unknown / none / some, and what there is to look at.
  const looks = [{}, { imageUrl: "https://example.com/a.jpg" }, { amazonUrl: "https://www.amazon.com/dp/B0TESTTEST" }, { websiteUrl: "https://example.com/a" }];
  const data = [];
  for (const archived of [false, true]) {
    for (const giftable of [true, false]) {
      for (const stock of [null, 0, 5]) {
        for (const look of looks) data.push({ brandId: BRAND, sku: `S-${data.length}`, title: "Tablecloth", archived, giftable, stock, ...look });
      }
    }
  }
  await db.product.createMany({ data });
  const all = await db.product.findMany({ where: { brandId: BRAND } });
  assert.equal(all.length, 48);

  let counted = 0;
  for (const status of OFFER_STATUSES) {
    const found = await db.product.findMany({ where: { AND: [{ brandId: BRAND }, OFFER_STATUS_WHERE[status]] }, select: { sku: true } });
    const expected = all.filter((product) => offerStatus(product) === status).map((product) => product.sku);
    assert.deepEqual(found.map((product) => product.sku).sort(), expected.sort(), `"${status}" must mean the same in both places`);
    counted += found.length;
  }
  assert.equal(counted, all.length, "every product has exactly one status");
  // 2 of the 3 stock states, 3 of the 4 "looks", live and switched on.
  assert.equal(all.filter((product) => offerStatus(product) === "offered").length, 6);
});

/* --------------------------------------------------------------------------
 * Two brands, and people who work on one of them.
 * ------------------------------------------------------------------------ */

test("someone who works on one brand can find only that brand's campaigns, creators, gift orders and activity", async () => {
  const { activityIn, activityOfInfluencer, allowed, viewed } = await import("@/lib/brand-scope");
  const { findPossibleDuplicates } = await import("@/lib/review-queue");
  const A = "scope-a";
  const B = "scope-b";

  const person = (name: string) => db.user.create({ data: { name, email: `${name}@scope.example`, passwordHash: "x" } });
  const [anna, bela] = await Promise.all([person("anna"), person("bela")]);
  // What the session hands to the pages and actions for each kind of person.
  const onA = { id: anna.id, brandId: A, viewBrand: A };
  const onB = { id: bela.id, brandId: B, viewBrand: B };
  const both = { id: anna.id, brandId: null, viewBrand: null };

  const campaign = (name: string, brandId: string) =>
    db.campaign.create({ data: { name, brandId, brief: "Gift linens.", nicheKeywords: [], negativeKeywords: [] } });
  const [campaignA, campaignB] = await Promise.all([campaign("scope campaign A", A), campaign("scope campaign B", B)]);

  // One creator each, one who works with both brands, and one in no campaign at all.
  const onlyA = await makeCreator(campaignA.id, "scope_only_a");
  const onlyB = await makeCreator(campaignB.id, "scope_only_b");
  const sharedInA = await makeCreator(campaignA.id, "scope_shared");
  const sharedInB = await db.campaignCreator.create({ data: { campaignId: campaignB.id, influencerId: sharedInA.influencerId } });
  const nobody = await db.influencer.create({ data: { name: "In no campaign", profiles: { create: { platform: "instagram", handle: "scope_nobody" } } } });

  const product = (sku: string, brandId: string) => db.product.create({ data: { brandId, sku, title: "Tablecloth" } });
  const [productA, productB] = await Promise.all([product("SCOPE-A", A), product("SCOPE-B", B)]);
  const gift = (campaignCreatorId: string, productId: string) =>
    db.giftOrder.create({
      data: {
        campaignCreatorId, productId, status: "approved", shipName: "Test Person", address1: "1 Main St",
        city: "Austin", state: "TX", postalCode: "78701", country: "United States",
      },
    });
  const [giftA, giftB] = await Promise.all([gift(onlyA.id, productA.id), gift(onlyB.id, productB.id)]);

  const note = (body: string, userId: string, ids: { campaignCreatorId?: string; influencerId?: string } = {}) =>
    db.activity.create({ data: { userId, kind: "note", body, ...ids } });
  await note("in campaign A", anna.id, { campaignCreatorId: onlyA.id, influencerId: onlyA.influencerId });
  await note("in campaign B", bela.id, { campaignCreatorId: onlyB.id, influencerId: onlyB.influencerId });
  await note("shared creator in A", anna.id, { campaignCreatorId: sharedInA.id, influencerId: sharedInA.influencerId });
  await note("shared creator in B", bela.id, { campaignCreatorId: sharedInB.id, influencerId: sharedInB.influencerId });
  await note("shared creator edited", bela.id, { influencerId: sharedInA.influencerId });
  await note("anna imported a file", anna.id);
  await note("bela imported a file", bela.id);

  const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort();
  const bodies = async (where: object) => (await db.activity.findMany({ where, select: { body: true } })).map((row) => row.body).sort();
  const mine = { id: { in: [onlyA.influencerId, onlyB.influencerId, sharedInA.influencerId, nobody.id] } };

  // Lists: each brand gets its own, and a creator who works with both appears in both.
  for (const [viewer, own, ownCreators, ownPeople, ownGift, ownProduct] of [
    [onA, campaignA, [onlyA, sharedInA], [onlyA.influencerId, sharedInA.influencerId], giftA, productA],
    [onB, campaignB, [onlyB, sharedInB], [onlyB.influencerId, sharedInA.influencerId], giftB, productB],
  ] as const) {
    const scope = viewed(viewer);
    assert.deepEqual(ids(await db.campaign.findMany({ where: scope.campaigns })), [own.id]);
    assert.deepEqual(ids(await db.campaignCreator.findMany({ where: scope.creators })), ids([...ownCreators]));
    assert.deepEqual(ids(await db.influencer.findMany({ where: scope.influencers })), [...ownPeople].sort());
    assert.deepEqual(ids(await db.giftOrder.findMany({ where: scope.gifts })), [ownGift.id]);
    assert.deepEqual(ids(await db.product.findMany({ where: scope.products })), [ownProduct.id]);
  }
  // Someone with both brands sees all four people, including the one in no campaign.
  assert.equal(await db.influencer.count({ where: { ...viewed(both).influencers, ...mine } }), 4);

  // Opening one record the way every page and action does: the other brand's is simply not there.
  const scopeA = allowed(onA);
  assert.equal(await db.campaign.findFirst({ where: { id: campaignB.id, ...scopeA.campaigns } }), null);
  assert.equal(await db.campaignCreator.findFirst({ where: { id: onlyB.id, ...scopeA.creators } }), null);
  assert.equal(await db.campaignCreator.findFirst({ where: { id: sharedInB.id, ...scopeA.creators } }), null, "the other brand's work with a shared creator");
  assert.equal(await db.influencer.findFirst({ where: { id: onlyB.influencerId, ...scopeA.influencers } }), null);
  assert.equal(await db.influencer.findFirst({ where: { id: nobody.id, ...scopeA.influencers } }), null, "a creator in no campaign belongs to no brand");
  assert.equal(await db.giftOrder.findFirst({ where: { id: giftB.id, ...scopeA.gifts } }), null);
  assert.equal(scopeA.includes(B), false);
  assert.ok(await db.campaignCreator.findFirst({ where: { id: onlyA.id, ...scopeA.creators } }));
  assert.ok(await db.influencer.findFirst({ where: { id: sharedInA.influencerId, ...scopeA.influencers } }));
  assert.ok(await db.giftOrder.findFirst({ where: { id: giftA.id, ...scopeA.gifts } }));

  // The sidebar choice narrows what someone with both brands looks at. It never widens anyone's view,
  // and it never changes what a person is allowed to open.
  assert.equal(viewed({ ...both, viewBrand: B }).brandId, B);
  assert.equal(allowed({ ...both, viewBrand: B }).brandId, null);
  assert.equal(viewed({ ...onA, viewBrand: B }).brandId, A);
  assert.equal(viewed({ ...onA, viewBrand: null }).brandId, A);

  // A brand nobody has heard of matches nothing rather than everything.
  const unknown = allowed({ id: anna.id, brandId: "no-such-brand", viewBrand: null });
  assert.equal(await db.campaign.count({ where: unknown.campaigns }), 0);
  assert.equal(await db.influencer.count({ where: unknown.influencers }), 0);
  assert.equal(await db.giftOrder.count({ where: unknown.gifts }), 0);

  // Activity: the brand's own campaigns, changes to a creator they work with, and their own imports.
  assert.deepEqual(await bodies(activityIn(viewed(onA), anna.id)), ["anna imported a file", "in campaign A", "shared creator edited", "shared creator in A"]);
  assert.deepEqual(await bodies(activityIn(viewed(onB), bela.id)), ["bela imported a file", "in campaign B", "shared creator edited", "shared creator in B"]);
  // On the shared creator's own page each brand sees its own journey and the changes to the person.
  assert.deepEqual(await bodies(activityOfInfluencer(viewed(onA), sharedInA.influencerId)), ["shared creator edited", "shared creator in A"]);
  assert.deepEqual(await bodies(activityOfInfluencer(viewed(both), sharedInA.influencerId)), ["shared creator edited", "shared creator in A", "shared creator in B"]);

  // "Possible duplicate" warnings never name a creator from the other brand.
  await db.socialProfile.create({ data: { influencerId: onlyB.influencerId, platform: "tiktok", handle: "scope.only.a" } });
  const item = {
    campaignCreatorId: onlyA.id, influencerId: onlyA.influencerId, name: "Person scope_only_a", email: null, location: null,
    status: "discovered" as const, priorityReview: false, score: null, lowFit: false, usSignal: null, emailStatus: "not_found" as const,
    reasons: [], model: null, latestPostUrl: null, latestPostAt: null,
    profiles: [{ id: "p", platform: "instagram" as const, handle: "scope_only_a", followers: null, bio: null, source: "manual" as const, fetchNote: null }],
  };
  assert.equal((await findPossibleDuplicates([item], scopeA.influencers)).size, 0);
  assert.equal((await findPossibleDuplicates([item], allowed(both).influencers)).get(onlyA.id)?.[0].influencerId, onlyB.influencerId);
});

test("the creator import fills blanks, never overwrites, keeps a note it cannot place, and stays inside the brand", async () => {
  const { importCreators, IMPORTED_NOTE } = await import("@/lib/creator-import");
  const { allowed } = await import("@/lib/brand-scope");
  const { user } = await makeUserAndCampaign("creator-import", ["home decor"]);
  const campaign = (name: string, brandId: string) =>
    db.campaign.create({ data: { name, brandId, brief: "Gift linens.", nicheKeywords: [], negativeKeywords: [] } });
  const [mine, theirs] = await Promise.all([campaign("Import campaign A", "import-a"), campaign("Import campaign B", "import-b")]);
  const onA = { id: user.id, brandId: "import-a", viewBrand: "import-a" };

  // A person the other brand already knows, with their own note and email.
  const known = await db.influencer.create({
    data: { name: "Known Person", email: "known@creator.example", notes: "Their note.", profiles: { create: { platform: "instagram", handle: "import_known" } } },
  });
  const csv = [
    "handle,platform,name,email,followers,campaign,status,notes,owner_email",
    `@import_new,instagram,New Person,new@creator.example,12.5k,,contacted,Said hello,${user.email}`,
    "https://www.instagram.com/import_known/,instagram,Someone Else,other@creator.example,900,Import campaign B,completed,Our note about them,",
    "import_new,instagram,,,,,,,",
  ].join("\n");

  // Someone tied to one brand must say which campaign the rows go into.
  const noCampaign = await importCreators(csv, { userId: user.id, scope: allowed(onA), fallbackCampaignId: "", fileName: "a.csv" });
  assert.equal(noCampaign.ok, false);

  // A check run reports everything and writes nothing.
  const check = await importCreators(csv, { userId: user.id, scope: allowed(onA), fallbackCampaignId: mine.id, fileName: "a.csv", checkOnly: true });
  assert.ok(check.ok);
  assert.deepEqual([check.added, check.updated, check.skipped], [1, 1, 1]);
  assert.equal(await db.campaignCreator.count({ where: { campaignId: mine.id } }), 0);

  const report = await importCreators(csv, { userId: user.id, scope: allowed(onA), fallbackCampaignId: mine.id, fileName: "a.csv" });
  assert.ok(report.ok);
  assert.deepEqual([report.added, report.updated, report.skipped], [1, 1, 1]);

  const fresh = await db.influencer.findFirstOrThrow({ where: { profiles: { some: { handle: "import_new" } } }, include: { campaigns: true } });
  assert.deepEqual([fresh.name, fresh.email, fresh.notes], ["New Person", "new@creator.example", "Said hello"]);
  assert.deepEqual([fresh.campaigns[0].campaignId, fresh.campaigns[0].status, fresh.campaigns[0].ownerId], [mine.id, "contacted", user.id]);

  // The other brand's campaign cannot be named: the row lands in the chosen one. Nothing about the
  // person is overwritten, and the note that could not be placed is kept in the activity.
  const kept = await db.influencer.findUniqueOrThrow({ where: { id: known.id }, include: { campaigns: true } });
  assert.deepEqual([kept.name, kept.email, kept.notes], ["Known Person", "known@creator.example", "Their note."]);
  assert.deepEqual(kept.campaigns.map((link) => [link.campaignId, link.status]), [[mine.id, "completed"]]);
  assert.equal(await db.campaignCreator.count({ where: { campaignId: theirs.id } }), 0);
  const note = await db.activity.findMany({ where: { influencerId: known.id, kind: "note" } });
  assert.deepEqual(note.map((entry) => [entry.body, entry.campaignCreatorId]), [[`${IMPORTED_NOTE}Our note about them`, kept.campaigns[0].id]]);
  const knownRow = report.details.find((detail) => detail.handle === "import_known");
  assert.match(knownRow?.notes.join(" ") ?? "", /"Import campaign B" not found; added to "Import campaign A" instead/);

  // The same file again changes nothing and repeats no note.
  const again = await importCreators(csv, { userId: user.id, scope: allowed(onA), fallbackCampaignId: mine.id, fileName: "a.csv" });
  assert.ok(again.ok);
  assert.deepEqual([again.added, again.updated, again.skipped], [0, 0, 3]);
  assert.equal(await db.activity.count({ where: { influencerId: known.id, kind: "note" } }), 1);
});

test("a gift whose content never came is closed as No content delivered, after the campaign's grace period, and shows on the record", async () => {
  const { runAutomations } = await import("@/lib/automation");
  const { describeTrackRecord, trackRecordFor } = await import("@/lib/track-record");
  const { allowed } = await import("@/lib/brand-scope");
  const { campaign } = await makeUserAndCampaign("no-content", ["home decor"]);
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);

  // Campaign default: closed 30 days after the content was due.
  const silent = await makeCreator(campaign.id, "nocontent_silent", { status: "content_expected", contentDueAt: ago(31) });
  const recent = await makeCreator(campaign.id, "nocontent_recent", { status: "content_expected", contentDueAt: ago(10) });
  const posted = await makeCreator(campaign.id, "nocontent_posted", { status: "content_posted", contentDueAt: ago(40) });
  const product = await db.product.create({ data: { brandId: "test", sku: "NC-1", title: "Runner", amazonUrl: "https://www.amazon.com/dp/B0TESTTEST" } });
  for (const creator of [silent, recent, posted]) {
    await db.giftOrder.create({
      data: {
        campaignCreatorId: creator.id, productId: product.id, status: "delivered", shipName: "T", address1: "1 St",
        city: "Austin", state: "TX", postalCode: "78701", country: "United States", deliveredAt: ago(45),
      },
    });
  }
  await db.post.create({ data: { campaignCreatorId: posted.id, socialProfileId: (await db.socialProfile.findFirstOrThrow({ where: { handle: "nocontent_posted" } })).id, url: "https://www.instagram.com/p/nocontent1/", postedAt: ago(5) } });

  const summary = await runAutomations("manual", now);
  assert.equal(summary.closedNoContent, 1);
  const read = (id: string) => db.campaignCreator.findUniqueOrThrow({ where: { id } });
  assert.equal((await read(silent.id)).status, "no_content");
  assert.equal((await read(silent.id)).nextAction, null, "a closed creator has no next action");
  assert.equal((await read(recent.id)).status, "content_expected", "ten days overdue is not long enough");
  assert.equal((await read(posted.id)).status, "content_posted");
  const log = await db.activity.findFirstOrThrow({ where: { campaignCreatorId: silent.id, kind: "status_change" }, include: { user: true } });
  assert.equal(log.automated, true);
  assert.equal(log.user.isSystem, true);
  assert.match(log.body, /No content delivered automatically/);
  // Running it again changes nothing.
  assert.equal((await runAutomations("manual", now)).closedNoContent, 0);

  // The record each person carries into the next decision.
  const scope = allowed({ id: "x", brandId: "test", viewBrand: "test" });
  const records = await trackRecordFor([silent.influencerId, recent.influencerId, posted.influencerId], scope);
  assert.deepEqual(describeTrackRecord(records.get(silent.influencerId)), { text: "Took a gift, never posted", tone: "danger" });
  assert.deepEqual(describeTrackRecord(records.get(recent.influencerId)), { text: "1 gift in progress", tone: "primary" });
  assert.deepEqual(describeTrackRecord(records.get(posted.influencerId)), { text: "1 collaboration posted", tone: "success" });
  assert.equal(records.get(posted.influencerId)?.posts, 1);
  // Another brand's gifts are not part of what this brand sees.
  assert.equal((await trackRecordFor([silent.influencerId], allowed({ id: "x", brandId: "other", viewBrand: "other" }))).size, 0);
});

test("a tracking number opens the right carrier's page", async () => {
  const { trackingUrl } = await import("@/lib/tracking");
  assert.match(trackingUrl("UPS", "1Z999AA10123456784"), /^https:\/\/www\.ups\.com\/track\?.*1Z999AA10123456784/);
  assert.match(trackingUrl(null, "1Z999AA10123456784"), /ups\.com/, "a UPS number is recognised without the carrier name");
  assert.match(trackingUrl("USPS", "9400111899223456789012"), /usps\.com/);
  assert.match(trackingUrl(null, "9400111899223456789012"), /usps\.com/);
  assert.match(trackingUrl("FedEx", "123456789012"), /fedex\.com/);
  assert.match(trackingUrl("Amazon Logistics", "TBA123456789000"), /track\.amazon\.com\/tracking\/TBA123456789000/);
  assert.match(trackingUrl("Some Courier", "ABC-123"), /google\.com\/search\?q=Some%20Courier%20ABC-123%20tracking/);
  assert.doesNotMatch(trackingUrl(null, "<script>"), /<script>/, "the number is always encoded");
});

test("no page or action opens a brand's record by its id alone", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const path = await import("node:path");

  // A lookup by id cannot carry a brand filter. Pages and actions must use findFirst with the
  // person's scope spread into it (see src/lib/brand-scope.ts), so the other brand's record is not found.
  const byIdAlone = /\bdb\.(campaign|campaignCreator|influencer|giftOrder)\.findUnique(OrThrow)?\(/;
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? files(full) : /\.tsx?$/.test(entry.name) ? [full] : [];
    });

  const offenders = [...files("src/actions"), ...files(path.join("src", "app", "(app)"))].flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, index) => (byIdAlone.test(line) ? [`${file}:${index + 1}`] : [])),
  );
  assert.deepEqual(offenders, [], "these lookups are not limited to the signed-in person's brand");
});

const ONE_DAY = 86_400_000;

test("a selection link is random, lasts 14 days, works once, and is replaced when reissued", async () => {
  const { ensureSelectionUrl, newSelectionToken, selectionLinkExpired, SELECTION_LINK_DAYS } = await import("@/lib/selection");
  const { recordSelection } = await import("@/lib/selection-flow");
  const { campaign } = await makeUserAndCampaign("links", ["home decor"]);
  const product = await db.product.create({ data: { brandId: "test", sku: "L-1", title: "Runner", stock: 3, amazonUrl: "https://www.amazon.com/dp/B0LINKTEST" } });
  const address = {
    shipName: "Lena Example", address1: "2 Oak St", address2: "", city: "Denver", state: "CO",
    postalCode: "80201", country: "United States", phone: "", note: "",
  };

  // 24 random bytes: 192 bits, never the same twice.
  assert.ok(Buffer.from(newSelectionToken(), "base64url").length >= 16);
  assert.notEqual(newSelectionToken(), newSelectionToken());

  // Issued: valid for 14 days from now, and the same link while it is valid.
  const fresh = await makeCreator(campaign.id, "link_fresh", { status: "interested" });
  const url = await ensureSelectionUrl(fresh.id);
  const issued = await db.campaignCreator.findUniqueOrThrow({ where: { id: fresh.id } });
  assert.ok(url.endsWith(`/select/${issued.selectionToken}`));
  const days = (issued.selectionExpiresAt!.getTime() - Date.now()) / ONE_DAY;
  assert.ok(days > SELECTION_LINK_DAYS - 0.01 && days <= SELECTION_LINK_DAYS, `expires in ${days} days`);
  assert.equal(await ensureSelectionUrl(fresh.id), url);

  // Expired: refused, and reissuing gives a different token.
  await db.campaignCreator.update({ where: { id: fresh.id }, data: { selectionExpiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await recordSelection(issued.selectionToken!, product.id, address)).ok, false);
  assert.equal(await db.giftOrder.count({ where: { campaignCreatorId: fresh.id } }), 0);
  const reissued = await ensureSelectionUrl(fresh.id);
  assert.notEqual(reissued, url);

  // Used: the token is dropped, so the same address answers nothing afterwards.
  const current = await db.campaignCreator.findUniqueOrThrow({ where: { id: fresh.id } });
  assert.equal((await recordSelection(current.selectionToken!, product.id, address)).ok, true);
  const after = await db.campaignCreator.findUniqueOrThrow({ where: { id: fresh.id } });
  assert.equal(after.selectionToken, null);
  assert.ok(after.selectionUsedAt);
  assert.equal(selectionLinkExpired(after), true);
  assert.equal((await recordSelection(current.selectionToken!, product.id, address)).ok, false);
  assert.equal(await db.giftOrder.count({ where: { campaignCreatorId: fresh.id } }), 1);
});

test("shipping details are stored encrypted and read back only through the key", async () => {
  const { seal, open, openAddress, addressEncryptionEnabled } = await import("@/lib/address-crypto");
  assert.equal(addressEncryptionEnabled(), true);
  const sealed = seal("1 Main St");
  assert.ok(sealed.startsWith("enc:v1:"));
  assert.notEqual(seal("1 Main St"), sealed, "a fresh random nonce every time");
  assert.equal(open(sealed), "1 Main St");
  assert.equal(open("Address not recorded"), "Address not recorded", "older plain rows pass through");
  assert.throws(() => open(sealed.slice(0, -3) + "AAA"), "a tampered value is refused");

  // What the selection test wrote is unreadable in the database and readable on the page.
  const order = await db.giftOrder.findFirstOrThrow({ where: { shipName: { startsWith: "enc:v1:" } } });
  assert.doesNotMatch(order.address1, /Main St|Oak St/);
  assert.match(openAddress(order).shipName, /Example$/);
});

test("the gift rules come from config/gift-rules.json and every decision names them", async () => {
  const { GIFT_RULES, checkGiftRules, describeRuleChecks } = await import("@/lib/gift-rules");
  const file = JSON.parse(readFileSync("config/gift-rules.json", "utf8")).rules;
  assert.equal(GIFT_RULES.maxQuantity, file.maxQuantity.value);
  assert.equal(GIFT_RULES.repeatGiftDays, file.repeatGiftDays.value);
  assert.deepEqual(GIFT_RULES.allowedCountries, file.allowedCountries.value);

  const now = new Date();
  const base = { country: "United States", quantity: 1, productPriceUsd: 27.99, collaborationType: null, approvedFee: null, lastGiftAt: null, now };
  assert.ok(checkGiftRules(base).every((check) => check.passed));
  assert.match(describeRuleChecks(checkGiftRules(base)), /^Approved under the rules: /);
  assert.ok(checkGiftRules({ ...base, productPriceUsd: null }).every((check) => check.passed), "an unknown price is allowed");

  const pricey = checkGiftRules({ ...base, productPriceUsd: (GIFT_RULES.maxProductPriceUsd ?? 0) + 1 });
  assert.equal(pricey.find((check) => check.rule === "maxProductPriceUsd")?.passed, false);
  const repeat = checkGiftRules({ ...base, lastGiftAt: new Date(now.getTime() - ONE_DAY) });
  assert.match(describeRuleChecks(repeat), /^Held for a person\. Failed: no other gift within the repeat window/);
  const many = checkGiftRules({ ...base, quantity: GIFT_RULES.maxQuantity + 1 });
  assert.equal(many.find((check) => check.rule === "maxQuantity")?.passed, false);

  // The held order from the selection test says which rule it failed.
  const held = await db.activity.findFirst({ where: { body: { contains: "Held for a person" } } });
  assert.match(held?.body ?? "", /ships to an allowed country/);
});

test("the public selection pages are rate limited per caller, and nothing readable is stored", async () => {
  const { hitRateLimit, isRateLimited, RATE_LIMITS } = await import("@/lib/rate-limit");
  const rule = { name: "test-rule", max: 2, windowMs: 60_000 };
  assert.equal(await hitRateLimit(rule, "1.2.3.4"), false);
  assert.equal(await hitRateLimit(rule, "1.2.3.4"), false);
  assert.equal(await hitRateLimit(rule, "1.2.3.4"), true, "the third request inside the window is refused");
  assert.equal(await isRateLimited(rule, "5.6.7.8"), false, "another caller is not affected");
  assert.ok(RATE_LIMITS.selectionMiss.max < RATE_LIMITS.selectionView.max, "guessing links is limited more tightly than opening them");
  const hit = await db.rateLimitHit.findFirstOrThrow();
  assert.doesNotMatch(hit.key, /1\.2\.3\.4|test-rule/);
});
