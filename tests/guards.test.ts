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
    YOUTUBE_API_KEY: "test-key",
    YOUTUBE_API_BASE_URL: `http://127.0.0.1:${STUB_PORT}/youtube`,
    // 350 units a day: two 100-unit searches fit under 80% (280), a third does not.
    YOUTUBE_DAILY_QUOTA: "350",
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
        const path = url.pathname.slice("/graph/".length);
        if (path === "ig_hashtag_search") return send(200, { data: [{ id: `17841${url.searchParams.get("q")}` }] });
        if (path.endsWith("/top_media")) {
          const tag = path.slice(5, -"/top_media".length);
          return send(200, {
            data: ["noauthor1", "noauthor2", "noauthor3", "known1"].map((code) => ({
              id: `${tag}-${code}`,
              caption: `A ${tag} post ${code}`,
              permalink: `https://www.instagram.com/p/${tag}-${code}/`,
              timestamp: "2026-10-01T10:00:00+0000",
            })),
          });
        }
        if (path === "instagram_oembed") {
          const link = url.searchParams.get("url") ?? "";
          return link.includes("known") ? send(200, { author_name: "known_author_x", html: "" }) : send(200, { html: "<blockquote>no author named</blockquote>" });
        }
        const fields = url.searchParams.get("fields") ?? "";
        const named = /business_discovery\.username\(([^)]+)\)/.exec(fields)?.[1];
        if (named) {
          return send(200, {
            business_discovery: { username: named, name: `Name of ${named}`, biography: "Home and textiles.", followers_count: 5000, media: { data: [{ caption: "Spring table", permalink: "https://www.instagram.com/p/x/", timestamp: "2026-09-30T10:00:00+0000", like_count: 100, comments_count: 10 }] } },
          });
        }
        return send(200, { data: [] });
      }

      if (url.pathname.startsWith("/youtube/")) {
        const path = url.pathname.slice("/youtube/".length);
        if (path === "search") {
          const q = (url.searchParams.get("q") ?? "").split(" ")[0];
          return send(200, { items: [1, 2].map((index) => ({ id: { channelId: `UC-${q}-${index}` } })) });
        }
        if (path === "channels") {
          const ids = (url.searchParams.get("id") ?? "").split(",").filter(Boolean);
          return send(200, {
            items: ids.map((id) => ({
              id,
              snippet: { title: `Channel ${id}`, description: "Home decor videos.", customUrl: `@${id.toLowerCase()}`, country: "US" },
              statistics: { subscriberCount: "12000" },
              contentDetails: { relatedPlaylists: { uploads: `UU-${id}` } },
            })),
          });
        }
        if (path === "playlistItems") {
          return send(200, { items: [{ snippet: { title: "Table styling", publishedAt: "2026-10-01T00:00:00Z" }, contentDetails: { videoId: "vid1", videoPublishedAt: "2026-10-01T00:00:00Z" } }] });
        }
        return send(404, { error: { message: "unknown path" } });
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
  // Delivered three days ago and nothing sent since: the arrival check (day 3) is the touch that is due.
  assert.equal(afterDelivery.nextAction, "Ask whether everything arrived");
  assert.equal(afterDelivery.nextActionDueAt?.getTime(), delivered.getTime() + 3 * DAY_MS, "arrival check 3 days after delivery");

  // Eight days after delivery the reminder is due; on the due day the posting-date check is.
  await runAutomations("manual", new Date(delivered.getTime() + 8 * DAY_MS));
  assert.equal((await read()).nextAction, "Send a content reminder");
  await runAutomations("manual", new Date(delivered.getTime() + 22 * DAY_MS));
  assert.equal((await read()).nextAction, "Check the agreed posting date");

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

test("YouTube discovery stops at 80% of the daily quota, counting every run of the day", async () => {
  const { runDiscovery } = await import("@/lib/discovery");
  const { youtubeBudget, pacificDayStart } = await import("@/lib/youtube-quota");
  assert.ok(pacificDayStart(new Date()).getTime() <= Date.now());
  assert.deepEqual(await youtubeBudget(), { daily: 350, limit: 280, usedToday: 0, remaining: 280 });

  const { user, campaign } = await makeUserAndCampaign("youtube-quota", ["linen", "quilt", "cushion"]);
  const first = await runDiscovery({ campaignId: campaign.id, source: "youtube", userId: user.id });
  const report = first.report as { searches: { keyword: string }[]; searchesSkippedForBudget: string[]; channelsFetched: number; uploadsRead: number };
  assert.deepEqual(report.searches.map((row) => row.keyword), ["linen", "quilt"], "two searches fit under the allowance");
  assert.deepEqual(report.searchesSkippedForBudget, ["cushion"], "the third would cross 80% and is not made");
  assert.equal(first.status, "stopped_quota");
  assert.match(first.note ?? "", /80% of the YouTube daily quota/);
  assert.equal(first.found, 4, "the channels of the two searches were still read");
  assert.equal(first.added, 4);
  assert.equal(report.uploadsRead, 4);
  assert.equal(first.quotaUsed, 200 + 1 + 4, "two searches, one channels call, four upload reads");
  assert.equal(await db.campaignCreator.count({ where: { campaignId: campaign.id, status: "discovered" } }), 4);

  // The ledger counts that run: a second run today has no room for a single search.
  assert.equal((await youtubeBudget()).remaining, 280 - 205);
  const { campaign: another } = await makeUserAndCampaign("youtube-quota-2", ["napkin"]);
  const second = await runDiscovery({ campaignId: another.id, source: "youtube", userId: user.id });
  assert.equal(second.status, "stopped_quota");
  assert.equal(second.found, 0);
  assert.equal(second.quotaUsed, 0, "nothing was spent once the allowance was used up");
  const stored = await db.discoveryRun.findUniqueOrThrow({ where: { id: second.runId } });
  assert.equal(stored.status, "stopped_quota");
  assert.match(stored.note ?? "", /80%/);
});

test("Instagram posts Meta will not attribute wait for a handle, then pass dedupe and the do-not-contact list", async () => {
  const { runDiscovery, pendingPosts, attributePost, dismissPost } = await import("@/lib/discovery");
  // The hashtag-limit test used up the week's 30 tags; this test needs one.
  await db.hashtag.deleteMany();
  await db.suppression.create({ data: { platform: "instagram", handle: "blocked_handle", reason: "asked us to stop" } });
  const { user, campaign } = await makeUserAndCampaign("meta-fallback", ["block print"]);

  graphCalls.length = 0;
  const summary = await runDiscovery({ campaignId: campaign.id, source: "meta_free", userId: user.id });
  assert.equal(summary.status, "completed");
  assert.equal(summary.added, 1, "the one post with a named author became a creator");
  const report = summary.report as { hashtags: { tag: string; hashtagId: string | null; posts: number }[]; oembed: { calls: number; withAuthor: number; withoutAuthor: number }; businessDiscovery: { attempted: number; succeeded: number }; pending: unknown[] };
  assert.deepEqual(report.hashtags, [{ tag: "blockprint", hashtagId: "17841blockprint", posts: 4 }]);
  assert.deepEqual(report.oembed, { calls: 4, withAuthor: 1, withoutAuthor: 3, failed: 0 });
  assert.deepEqual(report.businessDiscovery, { attempted: 1, succeeded: 1 });
  assert.equal(report.pending.length, 3, "three posts wait for a reviewer");
  assert.equal((await db.hashtag.count({ where: { tag: "blockprint" } })), 1, "the hashtag counted against the 7-day allowance");
  assert.match(summary.note ?? "", /3 are waiting in the review queue/);

  const waiting = await pendingPosts(campaign.id);
  assert.equal(waiting.length, 3);
  const [one, two, three] = waiting.map((item) => item.post.permalink);

  // A new handle: looked up, added as Discovered with stats.
  const added = await attributePost({ runId: summary.runId, permalink: one, handle: "@fresh_handle", userId: user.id, userName: user.name });
  assert.deepEqual(added, { ok: true, outcome: "added", statsFound: true });
  const fresh = await db.socialProfile.findUniqueOrThrow({ where: { platform_handle: { platform: "instagram", handle: "fresh_handle" } }, include: { influencer: { include: { campaigns: true } } } });
  assert.equal(fresh.followers, 5000);
  assert.equal(fresh.influencer.campaigns[0]?.status, "discovered");

  // A handle already in the portal: nothing new is created.
  const before = await db.influencer.count();
  const known = await attributePost({ runId: summary.runId, permalink: two, handle: "known_author_x", userId: user.id, userName: user.name });
  assert.equal(known.ok && known.outcome, "known");
  assert.equal(await db.influencer.count(), before);

  // A handle on the do-not-contact list: refused, nothing created.
  const blocked = await attributePost({ runId: summary.runId, permalink: three, handle: "blocked_handle", userId: user.id, userName: user.name });
  assert.equal(blocked.ok && blocked.outcome, "blocked");
  assert.equal(await db.socialProfile.count({ where: { handle: "blocked_handle" } }), 0);

  assert.equal((await pendingPosts(campaign.id)).length, 0, "every post was dealt with");
  const run = await db.discoveryRun.findUniqueOrThrow({ where: { id: summary.runId } });
  const final = run.report as { attributed: { outcome: string }[] };
  assert.deepEqual(final.attributed.map((row) => row.outcome), ["added", "known", "blocked"]);
  assert.equal(await dismissPost({ runId: summary.runId, permalink: one }), false, "a post already handled cannot be dismissed twice");
});

test("scoring runs in slices the job tick can continue, records cost and the prompt version, and a brand version takes over", async () => {
  const { startScoring, scoringSlice, scoreCampaign, BATCH_SIZE } = await import("@/lib/scoring");
  const { tickJobs } = await import("@/lib/jobs");
  const { activePromptFor, createPromptVersion, buildSystemPrompt, DEFAULT_WEIGHTS } = await import("@/lib/scoring-prompts");
  const { user, campaign } = await makeUserAndCampaign("slices", ["home decor"]);
  for (let index = 0; index < 5; index += 1) await makeCreator(campaign.id, `slice_${index}`, { status: "discovered" });

  const runId = await startScoring({ campaignId: campaign.id, userId: user.id });
  // Someone else holds the run: a slice does no work and says it is still running.
  await db.scoringRun.update({ where: { id: runId }, data: { lockedUntil: new Date(Date.now() + 60_000) } });
  const held = await scoringSlice(runId);
  assert.equal(held.status, "running");
  assert.equal(held.totals.scored, 0);
  await db.scoringRun.update({ where: { id: runId }, data: { lockedUntil: null } });

  // The tick continues the run one slice at a time until it is done.
  let ticks = 0;
  for (; ticks < 10; ticks += 1) {
    const tick = await tickJobs();
    if (tick.scoring.find((row) => row.runId === runId)?.done) break;
  }
  assert.ok(ticks >= Math.ceil(5 / BATCH_SIZE) - 1, "more than one slice was needed");
  const run = await db.scoringRun.findUniqueOrThrow({ where: { id: runId } });
  assert.equal(run.status, "completed");
  assert.equal(run.scored, 5);
  assert.equal(run.promptVersion, "fit-v1");
  assert.ok(Number(run.estimatedCostUsd) > 0, "a cost estimate is recorded");
  assert.equal(run.cursor, null);
  assert.equal(await db.campaignCreator.count({ where: { campaignId: campaign.id, status: "scored" } }), 5);

  // A brand version of the prompt: saved, active, carried into the next run's assessments.
  const weights = { ...DEFAULT_WEIGHTS, relevance: 40, usAudience: 10 };
  await createPromptVersion({ brandId: "test", guidance: "Judge creators for a test brand that sells block-printed linens in the US.", weights, note: "test", userId: user.id });
  const active = await activePromptFor("test");
  assert.equal(active.label, "test:v1");
  assert.match(active.systemPrompt, /Relevance to the campaign brief and niche keywords: 40 points/);
  assert.equal(buildSystemPrompt(active.guidance, weights), active.systemPrompt);
  await makeCreator(campaign.id, "slice_after_version", { status: "discovered" });
  const again = await scoreCampaign(campaign.id, user.id);
  assert.equal(again.status, "completed");
  assert.equal(again.promptVersion, "test:v1");
  const latest = await db.fitAssessment.findFirstOrThrow({ where: { campaignCreator: { campaignId: campaign.id } }, orderBy: { createdAt: "desc" } });
  assert.equal(latest.promptVersion, "test:v1");
  assert.equal(latest.scoringPromptId, active.id);
});

test("the outreach figures mean the same thing everywhere", async () => {
  const { personStats, brandTargets, replyRate, weeklyStats } = await import("@/lib/outreach-stats");
  const { user: anna, campaign } = await makeUserAndCampaign("outreach", ["home decor"]);
  const ben = await db.user.create({ data: { name: "Ben", email: "ben-outreach@example.com", passwordHash: "x", role: "marketer", brandId: "test" } });
  const followUp = await db.template.create({ data: { name: "Follow-up test", purpose: "followup", body: "Hi {name}" } });
  const first = await makeCreator(campaign.id, "outreach_one", { status: "contacted", ownerId: anna.id });
  const second = await makeCreator(campaign.id, "outreach_two", { status: "contacted", ownerId: anna.id });
  const now = new Date();
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000);
  await db.message.createMany({
    data: [
      { campaignCreatorId: first.id, userId: anna.id, channel: "dm", direction: "outbound", body: "hello", sentAt: at(50) },
      { campaignCreatorId: first.id, userId: anna.id, channel: "dm", direction: "outbound", body: "following up", templateId: followUp.id, sentAt: at(40) },
      { campaignCreatorId: second.id, userId: anna.id, channel: "dm", direction: "outbound", body: "hello", sentAt: at(30) },
      { campaignCreatorId: first.id, userId: anna.id, channel: "dm", direction: "inbound", body: "yes please", sentAt: at(20) },
      { campaignCreatorId: second.id, userId: ben.id, channel: "dm", direction: "outbound", body: "hi", sentAt: at(10) },
    ],
  });
  await db.activity.create({ data: { userId: anna.id, kind: "status_change", campaignCreatorId: first.id, body: "Status changed from Replied to Agreed." } });

  const stats = await personStats({ from: at(60), to: new Date(now.getTime() + 60_000) }, { id: campaign.id });
  const annaRow = stats.find((row) => row.userId === anna.id)!;
  const benRow = stats.find((row) => row.userId === ben.id)!;
  assert.deepEqual(
    { messages: annaRow.messages, creators: annaRow.creators, replies: annaRow.replies, followUps: annaRow.followUps, agreed: annaRow.agreed },
    { messages: 3, creators: 2, replies: 1, followUps: 1, agreed: 1 },
  );
  assert.equal(replyRate(annaRow), 50, "replies divided by distinct creators messaged, not by messages");
  assert.deepEqual({ messages: benRow.messages, creators: benRow.creators, replies: benRow.replies }, { messages: 1, creators: 1, replies: 0 });
  assert.equal(replyRate(benRow), 0);
  assert.equal(replyRate({ replies: 0, creators: 0 }), null);

  assert.deepEqual(await brandTargets(["test"]), new Map([["test", { daily: 20, weekly: 100, creatorConnectionsUrl: null }]]), "defaults until the team sets targets");
  await db.brandSettings.create({ data: { brandId: "test", dailyMessageTarget: 15, weeklyMessageTarget: 60 } });
  assert.deepEqual((await brandTargets(["test"])).get("test"), { daily: 15, weekly: 60, creatorConnectionsUrl: null });

  const weeks = await weeklyStats({ id: campaign.id }, 8);
  assert.equal(weeks.length, 8);
  assert.ok(weeks[0].people.some((row) => row.userId === anna.id), "this week lists Anna");
});

test("after delivery the touches come in order, each waiting until a message was logged for it", async () => {
  const { nextActionFor, deliverySteps, suggestedTemplate } = await import("@/lib/next-action");
  const timings = { followUpAfterDays: 4, maxFollowUps: 2, closeAfterDays: 7, arrivalCheckDays: 3, selectionWaitDays: 5, deliveryWaitDays: 10, contentReminderDays: 7, contentDueDays: 14, noContentAfterDays: 30 };
  const delivered = new Date("2026-10-01T12:00:00Z");
  const day = (days: number) => new Date(delivered.getTime() + days * ONE_DAY);
  const base = { status: "content_expected" as const, followUpsSent: 0, selectionSentAt: null, contentDueAt: day(14), reengageAfter: null, gift: { status: "delivered" as const, shippedAt: day(-5), deliveredAt: delivered } };

  assert.deepEqual(deliverySteps(delivered, timings).map((step) => [step.action, step.purpose]), [
    ["Send the delivery note", "delivered"],
    ["Ask whether everything arrived", "arrival"],
    ["Send a content reminder", "reminder"],
    ["Check the agreed posting date", "deadline"],
  ]);

  // Delivery day: the note is due now, nothing has been sent since delivery.
  const noteDue = nextActionFor({ ...base, lastContactedAt: day(-6) }, timings, day(0.1));
  assert.deepEqual([noteDue.action, noteDue.waitingOn], ["Send the delivery note", "team"]);
  assert.equal(suggestedTemplate("content_expected", noteDue.action), "delivered");

  // Note sent on day 0: nothing until day 3, then the arrival check.
  const waiting = nextActionFor({ ...base, lastContactedAt: day(0.2) }, timings, day(1));
  assert.deepEqual([waiting.action, waiting.waitingOn, waiting.dueAt?.getTime()], ["Waiting for content", "creator", day(3).getTime()]);
  const arrival = nextActionFor({ ...base, lastContactedAt: day(0.2) }, timings, day(3.5));
  assert.deepEqual([arrival.action, suggestedTemplate("content_expected", arrival.action)], ["Ask whether everything arrived", "arrival"]);

  // Arrival check sent: the reminder waits for day 7, then the posting-date check for day 14.
  const reminder = nextActionFor({ ...base, lastContactedAt: day(3.6) }, timings, day(8));
  assert.deepEqual([reminder.action, suggestedTemplate("content_expected", reminder.action)], ["Send a content reminder", "reminder"]);
  const deadline = nextActionFor({ ...base, lastContactedAt: day(7.5) }, timings, day(15));
  assert.deepEqual([deadline.action, suggestedTemplate("content_expected", deadline.action)], ["Check the agreed posting date", "deadline"]);

  // A touch the team skipped gives way to the later one once its day comes.
  const skipped = nextActionFor({ ...base, lastContactedAt: day(-6) }, timings, day(9));
  assert.equal(skipped.action, "Send a content reminder");

  // Every touch done: wait quietly; the no-content timer closes it in its own time.
  const done = nextActionFor({ ...base, lastContactedAt: day(14.5) }, timings, day(20));
  assert.deepEqual([done.action, done.waitingOn, done.dueAt], ["Waiting for content", "creator", null]);

  // Without a delivery date the old behaviour holds.
  const undelivered = nextActionFor({ ...base, lastContactedAt: day(-6), gift: { status: "shipped" as const, shippedAt: day(-5), deliveredAt: null } }, timings, day(1));
  assert.equal(undelivered.action, "Waiting for content");
});

test("the performance dashboard resolves periods in the app zone and counts what happened inside them", async () => {
  const { resolvePeriod, figuresFor, previousPeriod, bucketsFor } = await import("@/lib/performance-stats");
  const { startOfWeekInZone, startOfMonthInZone, dayValueInZone } = await import("@/lib/format");
  const now = new Date();
  assert.equal(resolvePeriod("this-week", undefined, undefined, now).from.getTime(), startOfWeekInZone(now).getTime());
  assert.equal(resolvePeriod("this-month", undefined, undefined, now).from.getTime(), startOfMonthInZone(now).getTime());
  const lastMonth = resolvePeriod("last-month", undefined, undefined, now);
  assert.equal(lastMonth.to.getTime(), startOfMonthInZone(now).getTime());
  assert.ok(lastMonth.from < lastMonth.to);
  const custom = resolvePeriod("custom", "2026-09-01", "2026-09-30", now);
  assert.equal(dayValueInZone(custom.from), "2026-09-01");
  assert.equal(dayValueInZone(new Date(custom.to.getTime() - 1)), "2026-09-30");
  assert.equal(resolvePeriod("custom", "nonsense", "2026-09-30", now).key, "this-week", "bad dates fall back to this week");
  assert.equal(resolvePeriod("anything", undefined, undefined, now).key, "this-week");
  const before = previousPeriod(custom);
  assert.equal(before.to.getTime(), custom.from.getTime());

  // Figures: one of each event inside the period, one outside.
  const { user, campaign } = await makeUserAndCampaign("performance", ["home decor"]);
  const inside = new Date("2026-09-15T10:00:00Z");
  const outside = new Date("2026-08-15T10:00:00Z");
  const a = await makeCreator(campaign.id, "perf_one", { status: "content_posted", createdAt: inside });
  const b = await makeCreator(campaign.id, "perf_two", { status: "no_content", createdAt: outside });
  await db.activity.createMany({
    data: [
      { userId: user.id, kind: "status_change", campaignCreatorId: a.id, body: "Status changed from Approved to Contacted.", createdAt: inside },
      { userId: user.id, kind: "status_change", campaignCreatorId: a.id, body: "Status changed from Replied to Agreed.", createdAt: inside },
      { userId: user.id, kind: "status_change", campaignCreatorId: b.id, body: "Status changed from Content expected to No content delivered.", createdAt: inside, automated: true },
      { userId: user.id, kind: "status_change", campaignCreatorId: b.id, body: "Status changed from Approved to Contacted.", createdAt: outside },
    ],
  });
  const product = await db.product.create({ data: { brandId: "test", sku: "PERF-1", title: "Runner", stock: 1 } });
  await db.giftOrder.create({ data: { campaignCreatorId: a.id, productId: product.id, status: "delivered", shipName: "x", address1: "x", city: "x", state: "x", postalCode: "x", country: "United States", createdAt: inside, shippedAt: inside, deliveredAt: inside } });
  await db.message.createMany({ data: [{ campaignCreatorId: a.id, userId: user.id, channel: "dm", direction: "outbound", body: "hi", sentAt: inside }, { campaignCreatorId: a.id, userId: user.id, channel: "dm", direction: "inbound", body: "yes", sentAt: inside }] });
  const profile = await db.socialProfile.findFirstOrThrow({ where: { influencerId: a.influencerId } });
  await db.post.create({ data: { campaignCreatorId: a.id, socialProfileId: profile.id, url: "https://www.instagram.com/p/perf1/", createdAt: inside } });

  const figures = await figuresFor(custom, { id: campaign.id });
  assert.deepEqual(figures, { creatorsAdded: 1, messages: 1, replies: 1, contacted: 1, agreed: 1, giftsOrdered: 1, giftsShipped: 1, giftsDelivered: 1, posted: 1, completed: 0, noContent: 1, contentRate: 50 });
  const buckets = await bucketsFor(custom, { id: campaign.id });
  assert.ok(buckets.length >= 4 && buckets.length <= 6, "September splits into weeks");
  assert.equal(buckets.reduce((sum, bucket) => sum + bucket.figures.posted, 0), 1);
  const empty = await figuresFor(previousPeriod(custom), { id: campaign.id });
  assert.equal(empty.contacted, 1, "the August contact falls in the previous period");
  assert.equal(empty.posted, 0);
});

test("Creator Connections creators are reached inside Amazon first, then by DM or email, and Amazon messages count like any other", async () => {
  const { destinationsFor, defaultDestination, pickTemplate, mailtoFor } = await import("@/lib/channels");
  const { personStats } = await import("@/lib/outreach-stats");
  const profiles = [{ id: "p1", platform: "instagram" as const, handle: "maya" }];

  // Nothing to reach them on: no button. All three: DM, Amazon, email, in that order.
  assert.deepEqual(destinationsFor({ profiles: [] }), []);
  const all = destinationsFor({ profiles, email: "maya@example.com", amazonCreator: true });
  assert.deepEqual(all.map((destination) => destination.channel), ["dm", "amazon", "email"]);
  // Not yet contacted: Amazon first, where they applied. Once in conversation: the DM.
  assert.equal(defaultDestination(all, "approved")?.channel, "amazon");
  assert.equal(defaultDestination(all, "contacted")?.channel, "dm");
  assert.equal(defaultDestination(destinationsFor({ profiles: [], email: "x@y.z" }), "approved")?.channel, "email");

  // Templates named Amazon are used only in the Amazon thread.
  const templates = [
    { id: "a", name: "First message", purpose: "first" },
    { id: "b", name: "Amazon: first message", purpose: "first" },
    { id: "c", name: "Follow-up", purpose: "followup" },
  ];
  assert.equal(pickTemplate(templates, "first", "amazon")?.id, "b");
  assert.equal(pickTemplate(templates, "first", "dm")?.id, "a");
  assert.equal(pickTemplate(templates, "followup", "amazon")?.id, "c");
  assert.equal(mailtoFor("maya@example.com", "A gift", "Hi Maya"), "mailto:maya%40example.com?subject=A%20gift&body=Hi%20Maya");

  // An Amazon message is stored on its own channel and counts in the outreach figures like a DM.
  const { user, campaign } = await makeUserAndCampaign("amazon-channel", ["home"]);
  const creator = await makeCreator(campaign.id, "amazon_creator", { status: "contacted", lastContactedAt: new Date() });
  await db.message.create({ data: { campaignCreatorId: creator.id, userId: user.id, channel: "amazon", direction: "outbound", body: "Hi via Amazon" } });
  const stats = await personStats({ from: new Date(Date.now() - DAY_MS), to: new Date(Date.now() + 60_000) }, { id: campaign.id });
  assert.equal(stats.find((row) => row.userId === user.id)?.messages, 1);
});

test("Rachna greets once a day, obeys the tips toggle, and never sits on a button or a field", async () => {
  const { greetingDue, tipsAllowed, placeBubble, greetingFor, nudgeFor, tourKeyFor } = await import("@/lib/rachna");

  // Once per day: the first visit greets, the second does not, tomorrow does again.
  assert.equal(greetingDue(null, "2026-10-23"), true);
  assert.equal(greetingDue("2026-10-23", "2026-10-23"), false);
  assert.equal(greetingDue("2026-10-22", "2026-10-23"), true);

  // The toggle silences everything but the tour.
  assert.equal(tipsAllowed(false, "greeting"), false);
  assert.equal(tipsAllowed(false, "nudge"), false);
  assert.equal(tipsAllowed(false, "milestone"), false);
  assert.equal(tipsAllowed(false, "tour"), true);
  assert.equal(tipsAllowed(true, "nudge"), true);

  // Placement: below the anchor when free; moved when a blocked element sits there; the corner when nothing fits.
  const anchor = { x: 100, y: 100, w: 800, h: 40 };
  const size = { w: 400, h: 140 };
  const viewport = { w: 1400, h: 900 };
  const free = placeBubble({ anchor, size, viewport, blocked: [] });
  assert.equal(free.placement, "below");
  const belowButton = { x: 160, y: 160, w: 80, h: 32 };
  const moved = placeBubble({ anchor, size, viewport, blocked: [belowButton] });
  assert.notEqual(moved.placement, "below");
  const movedRect = { x: moved.x, y: moved.y, ...size };
  assert.ok(!(movedRect.x < belowButton.x + belowButton.w && movedRect.x + movedRect.w > belowButton.x && movedRect.y < belowButton.y + belowButton.h && movedRect.y + movedRect.h > belowButton.y), "the bubble is not over the blocked element");
  const everywhere = [{ x: 0, y: 0, w: 1400, h: 700 }];
  assert.equal(placeBubble({ anchor, size, viewport, blocked: everywhere }).placement, "corner");
  assert.equal(placeBubble({ anchor: null, size, viewport, blocked: [] }).placement, "corner");

  // The copy is built from the counts, dropping a clause whose count is zero.
  assert.equal(greetingFor("Preeti", { replies: 2, parcels: 1, total: 9 }, 9).text, "Morning, Preeti! 2 replies first, then 1 parcel check.");
  assert.equal(greetingFor("Preeti", { replies: 1, parcels: 0, total: 3 }, 9).text, "Morning, Preeti! 1 reply first.");
  assert.equal(greetingFor("Preeti", { replies: 0, parcels: 0, total: 0 }, 9).pose, "think");
  // She matches the page's own greeting through the day.
  assert.equal(greetingFor("Preeti", { replies: 1, parcels: 0, total: 3 }, 14).text, "Afternoon, Preeti! 1 reply first.");
  assert.equal(greetingFor("Preeti", { replies: 1, parcels: 0, total: 3 }, 19).text, "Evening, Preeti! 1 reply first.");
  assert.equal(nudgeFor("agreed")?.text, "Send the selection link, one click.");
  assert.equal(nudgeFor("content_expected", { arrivalDays: 3 })?.text, "Delivery note today, arrival check in 3 days. I'll remind you.");
  assert.equal(nudgeFor("content_posted")?.pose, "cheer");
  assert.equal(nudgeFor("contacted"), null);
  assert.equal(tourKeyFor("/campaigns/abc"), "pipeline");
  assert.equal(tourKeyFor("/campaigns/abc/review"), null);
});

test("Rachna's quests, moods and pick come from the real counts", async () => {
  const { questsFor, dayCleared, questProgress, moodFor, pickFor, pickReason, INTRO } = await import("@/lib/rachna");

  // Quests measure the day against where it began; messages count up to the daily target.
  const start = { replies: 3, parcels: 1, approvals: 0, todaySent: 0, dailyTarget: 20, hot: 0 };
  const midday = questsFor({ replies: 1, parcels: 1, approvals: 0, todaySent: 5, dailyTarget: 20, hot: 0 }, start);
  assert.deepEqual(
    midday.map((quest) => [quest.key, quest.done, quest.total]),
    [
      ["replies", 2, 3],
      ["messages", 5, 20],
      ["parcels", 0, 1],
    ],
  );
  assert.equal(midday[0].label, "Reply to 3 creators");
  assert.equal(dayCleared(midday), false);
  assert.equal(questProgress(midday), 7 / 24);
  // A queue that grew during the day keeps an honest total; a queue empty all day is not a quest.
  const grown = questsFor({ replies: 5, parcels: 0, approvals: 0, todaySent: 0, dailyTarget: 20, hot: 0 }, start);
  assert.deepEqual([grown[0].done, grown[0].total], [0, 5]);
  assert.equal(grown.some((quest) => quest.key === "approvals"), false);
  // Every quest done clears the day; with nothing to do there are no quests and no false cheer.
  assert.equal(dayCleared(questsFor({ replies: 0, parcels: 0, approvals: 0, todaySent: 20, dailyTarget: 20, hot: 0 }, start)), true);
  // A backlog is not a day: a quest asks for ten at most and names the rest.
  const backlog = questsFor({ replies: 530, parcels: 0, approvals: 0, todaySent: 0, dailyTarget: 0, hot: 0 }, { ...start, replies: 535 });
  assert.deepEqual([backlog[0].label, backlog[0].done, backlog[0].total], ["Reply to 10 creators (535 waiting)", 5, 10]);
  // Hot replies are the first quest of the day.
  const withHot = questsFor({ replies: 2, parcels: 0, approvals: 0, todaySent: 0, dailyTarget: 0, hot: 1 }, { ...start, hot: 2 });
  assert.deepEqual([withHot[0].key, withHot[0].label, withHot[0].done, withHot[0].total], ["hot", "Answer 2 hot replies", 1, 2]);
  const nothing = { replies: 0, parcels: 0, approvals: 0, todaySent: 0, dailyTarget: 0, hot: 0 };
  assert.equal(questsFor(nothing, nothing).length, 0);
  assert.equal(dayCleared([]), false);

  // Her face: worried once anything is three days late, happy with an empty list.
  assert.equal(moodFor({ due: 0, lateMax: 0 }), "happy");
  assert.equal(moodFor({ due: 4, lateMax: 2 }), "idle");
  assert.equal(moodFor({ due: 4, lateMax: 3 }), "worried");

  // The pick: a reply beats a late follow-up; among replies the bigger audience; nothing picks nobody.
  const rows = [
    { queue: "followups", lateDays: 5, followers: 90_000, name: "A" },
    { queue: "replies", lateDays: 0, followers: 1_000, name: "B" },
    { queue: "replies", lateDays: 0, followers: 50_000, name: "C" },
  ];
  assert.equal(pickFor(rows)?.name, "C");
  assert.equal(pickFor([]), null);
  assert.equal(pickReason({ queue: "replies", lateDays: 0 }), "Replied, waiting for you");
  assert.equal(pickReason({ queue: "followups", lateDays: 2 }), "Follow-up due · 2 days late");

  // Her hello after sign-in.
  assert.match(INTRO.text, /^Hare Krishna! I'm Rachna/);
  assert.equal(INTRO.pose, "cheer");
});

test("Rachna reads a reply with the built-in rules: class, warmth, fee and questions, and never decides alone", async () => {
  const { readWithRules, feeIn, questionsIn, isReading, WARMTH_OF, SURE, afterReplyLine } = await import("@/lib/reply-reader");
  const { pickFor } = await import("@/lib/rachna");

  // The keen reply from the mockup: gifted, hot, two questions, no fee.
  const keen = readWithRules("Omg I love these tablecloths!! 😍 Which ones can I pick? Also do you ship to Canada? I usually do a reel + 3 stories for gifted collabs.");
  assert.equal(keen.replyClass, "interested_gifted");
  assert.equal(keen.sure, true);
  assert.equal(keen.warmth, "hot");
  assert.deepEqual(keen.questions, ["Which ones can I pick?", "Do you ship to Canada?"]);
  assert.equal(keen.summary, 'Keen on a gifted collab, asks which products, asks "Do you ship to Canada?"');
  assert.equal(keen.fee, null);
  assert.match(keen.summary, /^Keen on a gifted collab/);
  assert.equal(keen.reader, "rules");

  // A fee: rate_requested, warm, the number pulled out.
  const fee = readWithRules("Hi! My rate for a reel is $150, happy to send my media kit.");
  assert.deepEqual([fee.replyClass, fee.warmth, fee.fee], ["rate_requested", "warm", 150]);
  assert.equal(feeIn("around 1,200 USD for the bundle"), 1200);
  assert.equal(feeIn("no numbers here"), null);

  // Declines and parking read cold; affiliate reads warm; a product question alone is product_info.
  assert.deepEqual([readWithRules("Thanks but I'm not interested right now.").replyClass, readWithRules("Thanks but I'm not interested right now.").warmth], ["not_interested", "cold"]);
  assert.equal(readWithRules("Could we circle back after the holidays? Swamped till then.").replyClass, "maybe_later");
  assert.equal(readWithRules("Do you have an affiliate program or a promo code I could share?").replyClass, "interested_affiliate");
  assert.deepEqual([readWithRules("Which products are available to choose from?").replyClass, readWithRules("Which products are available to choose from?").warmth], ["product_info", "hot"]);

  // A question with no other signal needs an answer; a bare "ok" is not sure, so the person picks.
  assert.equal(readWithRules("How long would I have to post after it arrives?").replyClass, "needs_details");
  const unsure = readWithRules("ok");
  assert.equal(unsure.sure, false);
  assert.ok(unsure.confidence < SURE);
  assert.equal(unsure.warmth, null);
  assert.match(unsure.summary, /Not sure/);

  // Questions are tidy and capped at three.
  assert.equal(questionsIn("One? Two? Three? Four?").length, 3);
  assert.deepEqual(questionsIn("Love it. Sure thing!"), []);

  // What the form sends back must look like her reading, or it is dropped.
  assert.equal(isReading(keen), true);
  assert.equal(isReading({ ...keen, replyClass: "nonsense" }), false);
  assert.equal(isReading({ ...keen, confidence: 7 }), false);
  assert.equal(isReading("{}"), false);

  // Warmth follows the class the person confirms, so a hand-logged "interested" is hot too.
  assert.equal(WARMTH_OF.interested_gifted, "hot");
  assert.equal(WARMTH_OF.not_interested, "cold");
  assert.equal(WARMTH_OF.other, null);
  assert.match(afterReplyLine("interested_gifted")?.text ?? "", /selection link/);
  assert.equal(afterReplyLine("other"), null);

  // On Home a hot reply beats a warm one with the bigger audience.
  const rows = [
    { queue: "replies", lateDays: 0, followers: 90_000, name: "Warm", warmth: "warm" as const },
    { queue: "replies", lateDays: 0, followers: 5_000, name: "Hot", warmth: "hot" as const },
  ];
  assert.equal(pickFor(rows)?.name, "Hot");
});

test("the creator card grades a creator from their history and Rachna's verdict follows the figures", async () => {
  const { gradeCreator, rachnaVerdict, contentRate, reachMultiple, engagementRate, monthlySeries, PATIENCE_DAYS } = await import("@/lib/creator-card");
  const now = new Date("2026-10-26T10:00:00Z");
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
  const base = { firstName: "Priya", gifts: 0, giftValueUsd: 0, posts: 0, delivered: 0, noContent: 0, pending: 0, reach: 0, engagements: 0, clicks: 0, salesUsd: 0, followers: 20_000, fitScore: null, lastGiftAt: null, lastPostAt: null, amazonTier: null };

  // Nobody we have gifted is "new"; a star needs two posts and 80% delivered.
  assert.equal(gradeCreator(base), "new");
  const star = { ...base, gifts: 2, posts: 3, delivered: 2, reach: 90_000, engagements: 4_500, salesUsd: 240, lastGiftAt: days(40), lastPostAt: days(5) };
  assert.equal(gradeCreator(star), "star");
  assert.equal(gradeCreator({ ...base, gifts: 1, posts: 1, delivered: 1 }), "good");
  assert.equal(gradeCreator({ ...base, gifts: 3, posts: 1, delivered: 1, noContent: 2 }), "mixed");
  assert.equal(gradeCreator({ ...base, gifts: 1, pending: 1, lastGiftAt: days(3) }), "waiting");
  assert.equal(gradeCreator({ ...base, gifts: 1, noContent: 1 }), "risky");

  // The figures behind the tiles.
  assert.equal(contentRate(star), 100);
  assert.equal(contentRate(base), null);
  assert.equal(reachMultiple(star), 1.5);
  assert.equal(engagementRate(star), 5);

  // Her verdict: the grade's face and line, with the sales and reach flourishes when they exist.
  const verdict = rachnaVerdict(star, now);
  assert.equal(verdict.grade, "star");
  assert.equal(verdict.pose, "cheer");
  assert.match(verdict.text, /^Total gem\. 3 posts from 2 gifts, 100% delivered\./);
  assert.match(verdict.text, /\$240 in Amazon sales/);
  assert.match(verdict.text, /reach 1\.5× the follower count/);
  // Waiting turns into a chase after the patience window.
  assert.match(rachnaVerdict({ ...base, gifts: 1, pending: 1, lastGiftAt: days(3) }, now).text, /Give it till day 21/);
  const late = rachnaVerdict({ ...base, gifts: 1, pending: 1, lastGiftAt: days(PATIENCE_DAYS + 5) }, now);
  assert.equal(late.pose, "worried");
  assert.match(late.text, /Time to chase/);
  assert.match(rachnaVerdict({ ...base, gifts: 1, noContent: 1 }, now).text, /^Took a gift and never posted/);
  assert.match(rachnaVerdict({ ...base, fitScore: 82, amazonTier: "gold" }, now).text, /Fit score 82.*gold creator on Amazon/);

  // Imported collaborations marked posted with no post link still count as delivered content.
  const imported = { ...base, gifts: 1, delivered: 1, lastGiftAt: days(32) };
  assert.equal(gradeCreator(imported), "good");
  assert.match(rachnaVerdict(imported, now).text, /^Solid\. 1 collaboration from 1 gift, 100% delivered\./);
  // Amazon Creator Connections creators can deliver without a gift from us.
  const amazon = { ...base, delivered: 2, amazonTier: "silver" };
  assert.equal(gradeCreator(amazon), "star");
  assert.match(rachnaVerdict(amazon, now).text, /^Total gem\. 2 collaborations without a gift from us, 100% delivered\. Keep them close\./);
  // A no-content outcome without a gift on file is still a warning, not a fresh face.
  assert.equal(gradeCreator({ ...base, noContent: 1 }), "risky");
  // Not gifted yet: she reads the open conversation instead of calling them a fresh face.
  assert.match(rachnaVerdict({ ...base, stage: "replied", dueDays: 22 }, now).text, /^Replied and has been waiting on us for 22 days\. Answer today/);
  assert.equal(rachnaVerdict({ ...base, stage: "replied", dueDays: 22 }, now).pose, "worried");
  assert.match(rachnaVerdict({ ...base, stage: "agreed", dueDays: 0 }, now).text, /^They said yes\. Send the selection link before/);
  assert.match(rachnaVerdict({ ...base, stage: "discovered" }, now).text, /^Fresh face/);

  // The six-month chart counts each gift and post in its month, oldest first.
  const months = monthlySeries([{ at: days(2), kind: "post", reach: 1200, salesUsd: 30 }, { at: days(40), kind: "gift" }, { at: days(400), kind: "gift" }], 6, now);
  assert.equal(months.length, 6);
  assert.deepEqual([months[5].posts, months[5].reach, months[5].salesUsd, months[4].gifts], [1, 1200, 30, 1]);
  assert.equal(months.reduce((sum, point) => sum + point.gifts, 0), 1);
});
