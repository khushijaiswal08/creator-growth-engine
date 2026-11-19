/**
 * Guard tests: rules this app must never break, whatever an outside service does.
 *
 *   pnpm test
 *
 * They run against a throwaway in-memory Postgres and local stand-ins for the
 * Meta, YouTube, Anthropic and Amazon (MCF) APIs. That is the right tool here: the rules under test
 * are our own code (what we refuse to call, what we refuse to write), so the
 * outside service is deliberately replaced by one that misbehaves on demand.
 * These tests say nothing about whether the real services work.
 */
import assert from "node:assert/strict";
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import type { CreatorStatus, PrismaClient } from "@prisma/client";

const DB_PORT = 54331;
const STUB_PORT = 4011;
const DB_URL = `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres?sslmode=disable&connection_limit=1&pgbouncer=true`;
const DAY_MS = 24 * 60 * 60 * 1000;

let pglite: PGlite;
let socket: PGLiteSocketServer;
let stub: http.Server;
let db: PrismaClient;

/** Every request the stand-in Graph API received. */
const graphCalls: string[] = [];
/** When true, the stand-in refuses every oEmbed call, as Meta does for an app without oEmbed access. */
let oembedRefuses = false;
/** The stand-in Instagram Creator Marketplace: how it answers next, and every request it received (with the auth header). */
const marketplace = {
  mode: "ok" as "ok" | "token" | "permission" | "permission-270" | "rate-once" | "rate-always" | "rate-403" | "retry-after-long" | "bad-json-once" | "slow-503" | "server-echo",
  rateOnceDone: false,
  /** A careless API: echo the token back in paging.next and in error messages. */
  echoToken: false,
  requests: [] as { path: string; query: string; auth: string | null; status: number }[],
};
/** Runs before the stand-in Anthropic API answers; lets a test change the database mid-flight. */
let beforeAnthropicAnswers: (prompt: string) => Promise<void> = async () => {};
let anthropicRequests = 0;
/** The stand-in Amazon MCF: orders it has taken, and how it should behave next. */
const spapi = {
  orders: new Map<string, { status: string; tracking: string | null; packageStatus: string; body: Record<string, unknown>; pkg?: number }>(),
  /** after-store: Amazon took it but the answer is lost; after-store-down: and then Amazon cannot be reached at all. */
  createFails: "" as "" | "after-store" | "after-store-down" | "reject",
  /** Amazon cannot be reached for order lookups. */
  getFails: false,
  /** Answers an unknown order the way the 2020-07-01 version also does: 400 InvalidInput instead of 404. */
  notFoundAs400: false,
  /** Runs while Amazon is taking an order: something happening in the portal at that moment. */
  onCreate: null as null | (() => Promise<void>),
  /** Previews say Amazon cannot ship (no stock). */
  previewUnfulfillable: false,
  nextPkg: 7,
  tokenCalls: 0,
  calls: [] as string[],
};

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
    // Signs the local test storage addresses for creators' files.
    AUTH_SECRET: randomBytes(32).toString("base64"),
    YOUTUBE_API_KEY: "test-key",
    YOUTUBE_API_BASE_URL: `http://127.0.0.1:${STUB_PORT}/youtube`,
    // One-click Amazon MCF is switched on for Ridhi only, against the stand-in.
    SPAPI_BASE_URL: `http://127.0.0.1:${STUB_PORT}/spapi`,
    SPAPI_LWA_URL: `http://127.0.0.1:${STUB_PORT}/lwa`,
    SPAPI_LWA_CLIENT_ID: "test-client",
    SPAPI_LWA_CLIENT_SECRET: "test-secret",
    SPAPI_REFRESH_TOKEN_RIDHI: "test-refresh",
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

      // Instagram Creator Marketplace: GET {ig}/creator_marketplace_creators and GET {creator}?metadata=1.
      const graphPath = url.pathname.startsWith("/graph/") ? url.pathname.slice("/graph/".length) : "";
      const marketplaceList = /^v[\d.]+\/\d+\/creator_marketplace_creators$/.test(graphPath);
      const marketplaceCreator = /^v[\d.]+\/(c\d+)$/.exec(graphPath);
      if (marketplaceList || marketplaceCreator) {
        const auth = req.headers.authorization ?? null;
        const echo = marketplace.echoToken ? (auth ?? "").replace(/^Bearer /, "") : "abc123def456";
        const answer = (status: number, payload: unknown) => {
          marketplace.requests.push({ path: graphPath, query: url.search.slice(1), auth, status });
          return send(status, payload);
        };
        if (marketplace.mode === "token") return answer(400, { error: { message: `Invalid OAuth access token - Cannot parse access token ${echo}`, type: "OAuthException", code: 190 } });
        if (marketplace.mode === "permission") return answer(403, { error: { message: "(#10) Application does not have permission for this action", type: "OAuthException", code: 10 } });
        if (marketplace.mode === "permission-270") return answer(400, { error: { message: "(#270) This Ads API request is not allowed", code: 270 } });
        // Meta sends some rate limits as HTTP 403: the code decides.
        if (marketplace.mode === "rate-403") return answer(403, { error: { message: "(#4) Application request limit reached", code: 4 } });
        if (marketplace.mode === "retry-after-long") {
          marketplace.requests.push({ path: graphPath, query: url.search.slice(1), auth, status: 429 });
          res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
          return res.end(JSON.stringify({ error: { message: "(#4) Application request limit reached", code: 4 } }));
        }
        if (marketplace.mode === "bad-json-once" && !marketplace.rateOnceDone) {
          marketplace.rateOnceDone = true;
          marketplace.requests.push({ path: graphPath, query: url.search.slice(1), auth, status: 200 });
          res.writeHead(200, { "content-type": "text/html" });
          return res.end("<html>a proxy page, not JSON</html>");
        }
        if (marketplace.mode === "slow-503") {
          await new Promise((resolve) => setTimeout(resolve, 300));
          return answer(503, { error: { message: "Service temporarily unavailable", code: 2 } });
        }
        if (marketplace.mode === "rate-always" || (marketplace.mode === "rate-once" && !marketplace.rateOnceDone)) {
          marketplace.rateOnceDone = true;
          return answer(429, { error: { message: "(#4) Application request limit reached", code: 4 } });
        }
        if (marketplace.mode === "server-echo") return answer(500, { error: { message: `Unexpected error for https://graph.facebook.com/v27.0/1789/creator_marketplace_creators?access_token=${echo}&limit=25`, code: 1 } });
        if (marketplaceCreator) return answer(200, { id: marketplaceCreator[1], metadata: { fields: [{ name: "username" }, { name: "followers_count" }, { name: "biography" }, { name: "name" }, { name: "username" }] } });
        // Ids only unless fields were asked for, like the Graph API Explorer test of 6 Nov 2026.
        const asked = (url.searchParams.get("fields") ?? "").split(",");
        const shape = (creator: Record<string, unknown>) => (asked.includes("username") ? creator : { id: creator.id });
        const pageOne = [
          { id: "c1", username: "mk_maya", name: "Maya Market", biography: "Table linens and slow living", followers_count: 12_000 },
          { id: "c2" },
          { id: "c3", username: "mk_known", name: "Known Person" },
        ];
        const pageTwo = [
          { id: "c4", username: "mk_blocked", name: "Blocked" },
          { id: "c5", username: "mk_maya", name: "Maya Market" },
          { id: "c6", username: "mk_noah", name: "Noah", biography: "giveaway only account" },
        ];
        if (!url.searchParams.get("after")) {
          return answer(200, { data: pageOne.map(shape), paging: { cursors: { before: "B1", after: "AFTER1" }, next: `https://graph.facebook.com/v27.0/1789/creator_marketplace_creators?access_token=${echo}&limit=25&after=AFTER1` } });
        }
        return answer(200, { data: pageTwo.map(shape), paging: { cursors: { before: "B2", after: "AFTER2" } } });
      }

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
          if (oembedRefuses) return send(400, { error: { code: 10, message: "(#10) To use 'Meta oEmbed Read', your use of this endpoint must be reviewed and approved by Facebook." } });
          return link.includes("known") ? send(200, { author_name: "known_author_x", html: "" }) : send(200, { html: "<blockquote>no author named</blockquote>" });
        }
        const fields = url.searchParams.get("fields") ?? "";
        const named = /business_discovery\.username\(([^)]+)\)/.exec(fields)?.[1];
        if (named?.startsWith("norich_") && fields.includes("view_count")) {
          return send(400, { error: { code: 100, message: "(#100) Tried accessing nonexisting field (view_count) on node type (IGUser)" } });
        }
        if (named?.startsWith("insight_") || named?.startsWith("norich_")) {
          const ago = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString().replace(/\.\d{3}Z$/, "+0000");
          const rich = fields.includes("view_count");
          const post = (id: string, kind: string, path: string, days: number, extra: Record<string, unknown>, media: Record<string, unknown>) => ({ id, caption: id, permalink: `https://www.instagram.com/${path}/${named}-${kind}/`, timestamp: ago(days), comments_count: 1, ...extra, ...(rich ? media : {}) });
          return send(200, {
            business_discovery: {
              username: named,
              name: `Name of ${named}`,
              biography: "Home and textiles.",
              followers_count: 20_000,
              media: {
                data: [
                  { ...post("m1", "r1", "reel", 2, { like_count: 400 }, { media_type: "VIDEO", view_count: 9000 }), comments_count: 20 },
                  { ...post("m2", "p2", "p", 5, { like_count: 200 }, { media_type: "IMAGE" }), comments_count: 10 },
                  { ...post("m3", "p3", "p", 12, {}, { media_type: "CAROUSEL_ALBUM" }), comments_count: 4 },
                  { ...post("m4", "r4", "reel", 20, { like_count: 100 }, { media_type: "VIDEO", view_count: 3000 }), comments_count: 6 },
                  { ...post("m5", "p5", "p", 40, { like_count: 50 }, { media_type: "IMAGE" }), comments_count: 1 },
                ],
              },
            },
          });
        }
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
        if (path === "playlistItems" && (url.searchParams.get("playlistId") ?? "").includes("many")) {
          const ago = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
          return send(200, { items: [2, 9, 25].map((days, index) => ({ snippet: { title: `Video ${index + 1}`, publishedAt: ago(days) }, contentDetails: { videoId: `many${index + 1}`, videoPublishedAt: ago(days) } })) });
        }
        if (path === "videos") {
          const ids = (url.searchParams.get("id") ?? "").split(",").filter(Boolean);
          // many3 has hidden likes and comments: only a view count.
          return send(200, { items: ids.map((id, index) => ({ id, statistics: id === "many3" ? { viewCount: "1500" } : { viewCount: String(10_000 * (index + 1)), likeCount: String(500 * (index + 1)), commentCount: String(20 * (index + 1)) } })) });
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

      if (url.pathname === "/lwa") {
        spapi.tokenCalls += 1;
        return new URLSearchParams(body).get("refresh_token") === "test-refresh" ? send(200, { access_token: "test-access", token_type: "bearer", expires_in: 3600 }) : send(400, { error_description: "bad refresh token" });
      }
      if (url.pathname.startsWith("/spapi/fba/outbound/2020-07-01/")) {
        if (req.headers["x-amz-access-token"] !== "test-access") return send(403, { errors: [{ code: "Unauthorized", message: "Access to requested resource is denied." }] });
        const path = url.pathname.slice("/spapi/fba/outbound/2020-07-01".length);
        spapi.calls.push(`${req.method} ${path}`);
        if (req.method === "POST" && path === "/fulfillmentOrders/preview") {
          return send(200, {
            payload: {
              fulfillmentPreviews: [
                {
                  shippingSpeedCategory: "Standard",
                  isFulfillable: !spapi.previewUnfulfillable,
                  estimatedFees: [{ name: "FBAPerUnitFulfillmentFee", amount: { currencyCode: "USD", value: "5.10" } }, { name: "FBATransportationFee", amount: { currencyCode: "USD", value: "0.40" } }],
                  fulfillmentPreviewShipments: [{ earliestArrivalDate: "2026-11-04T00:00:00Z", latestArrivalDate: "2026-11-06T00:00:00Z" }],
                  unfulfillablePreviewItems: spapi.previewUnfulfillable ? [{ sellerSku: "x", quantity: 1, itemUnfulfillableReasons: ["InventoryUnavailable"] }] : [],
                },
              ],
            },
          });
        }
        if (req.method === "POST" && path === "/fulfillmentOrders") {
          const order = JSON.parse(body) as Record<string, unknown>;
          if (spapi.createFails === "reject") return send(400, { errors: [{ code: "InvalidInput", message: "Invalid postal code." }] });
          // Amazon refuses a second order with the same reference.
          if (spapi.orders.has(String(order.sellerFulfillmentOrderId))) return send(400, { errors: [{ code: "InvalidInput", message: "Duplicate sellerFulfillmentOrderId." }] });
          spapi.orders.set(String(order.sellerFulfillmentOrderId), { status: "Received", tracking: null, packageStatus: "IN_TRANSIT", body: order, pkg: spapi.nextPkg++ });
          if (spapi.onCreate) await spapi.onCreate();
          // Amazon took it, but the answer is lost on the way back (and, with "down", Amazon then stops answering).
          if (spapi.createFails === "after-store-down") spapi.getFails = true;
          if (spapi.createFails === "after-store" || spapi.createFails === "after-store-down") return send(503, { errors: [{ code: "ServiceUnavailable", message: "Try again later." }] });
          return send(200, {});
        }
        const one = /^\/fulfillmentOrders\/([^/]+)(\/cancel)?$/.exec(path);
        if (one) {
          if (spapi.getFails) return send(503, { errors: [{ code: "ServiceUnavailable", message: "Try again later." }] });
          const order = spapi.orders.get(decodeURIComponent(one[1]));
          if (!order) return spapi.notFoundAs400 ? send(400, { errors: [{ code: "InvalidInput", message: "Unable to get order. Order not found." }] }) : send(404, { errors: [{ code: "NotFound", message: "Requested order not found." }] });
          if (req.method === "PUT" && one[2]) {
            if (order.status !== "Received" && order.status !== "Planning") return send(400, { errors: [{ code: "InvalidInput", message: "Order cannot be cancelled in its current state." }] });
            order.status = "Cancelled";
            return send(200, {});
          }
          return send(200, {
            payload: {
              fulfillmentOrder: { sellerFulfillmentOrderId: one[1], fulfillmentOrderStatus: order.status },
              fulfillmentShipments: order.tracking
                ? [{ amazonShipmentId: "S1", fulfillmentCenterId: "PHX7", fulfillmentShipmentStatus: "SHIPPED", shippingDate: "2026-11-02T10:00:00Z", fulfillmentShipmentItem: [], fulfillmentShipmentPackage: [{ packageNumber: order.pkg ?? 0, carrierCode: "UPS", trackingNumber: order.tracking }] }]
                : [],
            },
          });
        }
        if (req.method === "GET" && path === "/tracking") {
          const order = [...spapi.orders.values()].find((entry) => entry.pkg === Number(url.searchParams.get("packageNumber")));
          return send(200, { payload: { packageNumber: Number(url.searchParams.get("packageNumber")), currentStatus: order?.packageStatus ?? "IN_TRANSIT", customerTrackingLink: "https://www.swiship.com/track?id=TBA1", trackingEvents: order?.packageStatus === "DELIVERED" ? [{ eventCode: "EVENT_301", eventDate: "2026-11-05T15:00:00Z" }] : [] } });
        }
        return send(404, { errors: [{ code: "NotFound", message: "unknown path" }] });
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
  const later = new Date(now.getTime() + 7 * DAY_MS + 1000);
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

async function makeCreator(campaignId: string, handle: string, data: Record<string, unknown> = {}) {
  const influencer = await db.influencer.create({
    data: { name: `Person ${handle}`, profiles: { create: { platform: "instagram", handle } } },
  });
  return db.campaignCreator.create({ data: { campaignId, influencerId: influencer.id, ...data } });
}
/** A creator who said yes and holds a selection link that is good for 14 days. */
const makeCreatorWithLink = (campaignId: string, handle: string, token: string, data: Record<string, unknown> = {}) =>
  makeCreator(campaignId, handle, { status: "interested", selectionToken: token, selectionExpiresAt: new Date(Date.now() + 14 * DAY_MS), ...data });
const readCreator = (id: string) => db.campaignCreator.findUniqueOrThrow({ where: { id } });
/** A US shipping address; each test changes only what it needs to. */
const usAddress = (over: Record<string, string> = {}) => ({
  shipName: "Jane Example", address1: "1 Main St", address2: "", city: "Austin", state: "TX",
  postalCode: "78701", country: "United States", phone: "", note: "", ...over,
});

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

  const dueNow = await readCreator(due.id);
  assert.equal(dueNow.status, "follow_up_due");
  assert.equal(dueNow.nextAction, "Send follow-up 1");
  assert.equal(dueNow.waitingOn, "team");

  const freshNow = await readCreator(fresh.id);
  assert.equal(freshNow.status, "contacted", "one day of silence is not enough");
  assert.equal(freshNow.waitingOn, "creator");
  assert.equal(freshNow.nextActionDueAt?.getTime(), ago(1).getTime() + 4 * DAY_MS);

  assert.equal((await readCreator(silent.id)).status, "no_reply");
  assert.equal((await readCreator(silent.id)).nextAction, null, "a closed creator has no next action");
  assert.equal((await readCreator(recentFinal.id)).status, "contacted", "the final wait has not run out yet");

  // Imported creators have no "last contacted" date: the portal must not guess.
  assert.equal((await readCreator(legacy.id)).status, "contacted");

  assert.equal((await readCreator(replied.id)).nextAction, "Answer the creator");
  assert.equal((await readCreator(done.id)).nextAction, null);
  assert.equal((await readCreator(blocked.id)).status, "blacklisted");
  assert.equal((await readCreator(blocked.id)).nextAction, null);

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

  const address = usAddress({ country: "usa", phone: "512-555-0100" });
  const withToken = (handle: string, token: string, data: Record<string, unknown> = {}) => makeCreatorWithLink(campaign.id, handle, token, data);

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
  const usNow = await readCreator(us.id);
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
  assert.equal((await readCreator(abroad.id)).nextAction, "Approve the gift order");

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
  const creator = await makeCreatorWithLink(campaign.id, "delivery_one", "token-delivery");
  await recordSelection("token-delivery", product.id, usAddress({ shipName: "Sam Example", address1: "2 Oak Ave", city: "Reno", state: "NV", postalCode: "89501" }));
  const gift = await db.giftOrder.findFirstOrThrow({ where: { campaignCreatorId: creator.id } });
  const read = () => readCreator(creator.id);

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
  await makeCreatorWithLink(campaign.id, "catalogue_one", "token-catalogue");
  const address = usAddress({ shipName: "Ana Example", address1: "3 Elm St", city: "Boise", state: "ID", postalCode: "83702" });
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
    reasons: [], latestPostUrl: null, latestPostAt: null,
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
  assert.equal((await readCreator(silent.id)).status, "no_content");
  assert.equal((await readCreator(silent.id)).nextAction, null, "a closed creator has no next action");
  assert.equal((await readCreator(recent.id)).status, "content_expected", "ten days overdue is not long enough");
  assert.equal((await readCreator(posted.id)).status, "content_posted");
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

test("a selection link is random, lasts 14 days, works once, and is replaced when reissued", async () => {
  const { ensureSelectionUrl, newSelectionToken, selectionLinkExpired, SELECTION_LINK_DAYS } = await import("@/lib/selection");
  const { recordSelection } = await import("@/lib/selection-flow");
  const { campaign } = await makeUserAndCampaign("links", ["home decor"]);
  const product = await db.product.create({ data: { brandId: "test", sku: "L-1", title: "Runner", stock: 3, amazonUrl: "https://www.amazon.com/dp/B0LINKTEST" } });
  const address = usAddress({ shipName: "Lena Example", address1: "2 Oak St", city: "Denver", state: "CO", postalCode: "80201" });

  // 24 random bytes: 192 bits, never the same twice.
  assert.ok(Buffer.from(newSelectionToken(), "base64url").length >= 16);
  assert.notEqual(newSelectionToken(), newSelectionToken());

  // Issued: valid for 14 days from now, and the same link while it is valid.
  const fresh = await makeCreator(campaign.id, "link_fresh", { status: "interested" });
  const url = await ensureSelectionUrl(fresh.id);
  const issued = await readCreator(fresh.id);
  assert.ok(url.endsWith(`/select/${issued.selectionToken}`));
  const days = (issued.selectionExpiresAt!.getTime() - Date.now()) / DAY_MS;
  assert.ok(days > SELECTION_LINK_DAYS - 0.01 && days <= SELECTION_LINK_DAYS, `expires in ${days} days`);
  assert.equal(await ensureSelectionUrl(fresh.id), url);

  // Expired: refused, and reissuing gives a different token.
  await db.campaignCreator.update({ where: { id: fresh.id }, data: { selectionExpiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await recordSelection(issued.selectionToken!, product.id, address)).ok, false);
  assert.equal(await db.giftOrder.count({ where: { campaignCreatorId: fresh.id } }), 0);
  const reissued = await ensureSelectionUrl(fresh.id);
  assert.notEqual(reissued, url);

  // Used: the token is dropped, so the same address answers nothing afterwards.
  const current = await readCreator(fresh.id);
  assert.equal((await recordSelection(current.selectionToken!, product.id, address)).ok, true);
  const after = await readCreator(fresh.id);
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
  const repeat = checkGiftRules({ ...base, lastGiftAt: new Date(now.getTime() - DAY_MS) });
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
  assert.equal(first.quotaUsed, 200 + 1 + 4 * 2, "two searches, one channels call, and for each of four channels the uploads read plus the video numbers");
  assert.equal(await db.campaignCreator.count({ where: { campaignId: campaign.id, status: "discovered" } }), 4);

  // The ledger counts that run: a second run today has no room for a single search.
  assert.equal((await youtubeBudget()).remaining, 280 - 209);
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

test("the job tick sleeps at night, skips the login middleware, and returns at once when nothing is running", async () => {
  const { tickJobs } = await import("@/lib/jobs");

  // Every run costs Netlify credits, so the schedule covers Indian working hours only, every ten minutes.
  const source = readFileSync("netlify/functions/job-tick.mts", "utf8");
  const schedule = /schedule:\s*"([^"]+)"/.exec(source)?.[1] ?? "";
  const [minute, hour] = schedule.split(" ");
  assert.equal(minute, "*/10", "every ten minutes");
  const [from, to] = hour.split("-").map(Number);
  assert.ok(from >= 2 && to <= 15, `UTC hours ${hour} stay inside 07:30 to 21:30 IST`);

  // The scheduler endpoints check CRON_SECRET themselves; the middleware would only add a billed edge request.
  const middleware = readFileSync("src/middleware.ts", "utf8");
  assert.ok(middleware.includes("api/cron|"), "the matcher leaves out /api/cron");

  // Nothing free to work on: the tick reports an empty summary.
  const running = { status: "running" as const, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] };
  const held = new Date(Date.now() + 60_000);
  const [discoveryIds, scoringIds] = await Promise.all([
    db.discoveryRun.findMany({ where: running, select: { id: true } }),
    db.scoringRun.findMany({ where: running, select: { id: true } }),
  ]);
  await db.discoveryRun.updateMany({ where: { id: { in: discoveryIds.map((row) => row.id) } }, data: { lockedUntil: held } });
  await db.scoringRun.updateMany({ where: { id: { in: scoringIds.map((row) => row.id) } }, data: { lockedUntil: held } });
  try {
    assert.deepEqual(await tickJobs(), { discovery: [], scoring: [], skipped: 0 });
  } finally {
    await db.discoveryRun.updateMany({ where: { id: { in: discoveryIds.map((row) => row.id) } }, data: { lockedUntil: null } });
    await db.scoringRun.updateMany({ where: { id: { in: scoringIds.map((row) => row.id) } }, data: { lockedUntil: null } });
  }
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

  assert.deepEqual(await brandTargets(["test"]), new Map([["test", { daily: 20, weekly: 100, weeklyGifts: 100, creatorConnectionsUrl: null }]]), "defaults until the team sets targets");
  await db.brandSettings.create({ data: { brandId: "test", dailyMessageTarget: 15, weeklyMessageTarget: 60 } });
  assert.deepEqual((await brandTargets(["test"])).get("test"), { daily: 15, weekly: 60, weeklyGifts: 100, creatorConnectionsUrl: null });

  const weeks = await weeklyStats({ id: campaign.id }, 8);
  assert.equal(weeks.length, 8);
  assert.ok(weeks[0].people.some((row) => row.userId === anna.id), "this week lists Anna");
});

test("after delivery the touches come in order, each waiting until a message was logged for it", async () => {
  const { nextActionFor, deliverySteps, suggestedTemplate } = await import("@/lib/next-action");
  const timings = { followUpAfterDays: 4, maxFollowUps: 2, closeAfterDays: 7, arrivalCheckDays: 3, selectionWaitDays: 5, deliveryWaitDays: 10, contentReminderDays: 7, contentDueDays: 14, noContentAfterDays: 30 };
  const delivered = new Date("2026-10-01T12:00:00Z");
  const day = (days: number) => new Date(delivered.getTime() + days * DAY_MS);
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
  // Late at night is still evening; morning starts at five.
  assert.equal(greetingFor("Preeti", { replies: 1, parcels: 0, total: 3 }, 2).text, "Evening, Preeti! 1 reply first.");
  assert.equal(nudgeFor("agreed")?.text, "Send the selection link, one click.");
  assert.equal(nudgeFor("content_expected", { arrivalDays: 3 })?.text, "Delivery note today, arrival check in 3 days. I'll remind you.");
  assert.equal(nudgeFor("content_posted")?.pose, "cheer");
  assert.equal(nudgeFor("contacted"), null);
  assert.equal(tourKeyFor("/campaigns/abc"), "pipeline");
  assert.equal(tourKeyFor("/campaigns/abc/review"), null);
});

test("Home greets on the team's clock: morning from 5, afternoon from noon, evening from 5 pm and through the night", async () => {
  const { hourInZone, timeOfDay } = await import("@/lib/format");
  const rachna = await import("@/lib/rachna");

  // The hour is read in the team's zone (APP_TIME_ZONE, IST on the live site), never the server's or the computer's.
  const zone = process.env.APP_TIME_ZONE?.trim() || "UTC";
  const noonUtc = new Date("2026-10-28T12:00:00Z");
  assert.equal(hourInZone(noonUtc), Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone: zone }).format(noonUtc)) % 24);

  const expected: Record<number, string> = { 0: "Evening", 2: "Evening", 4: "Evening", 5: "Morning", 9: "Morning", 11: "Morning", 12: "Afternoon", 16: "Afternoon", 17: "Evening", 21: "Evening", 23: "Evening" };
  for (const [hour, part] of Object.entries(expected)) assert.equal(rachna.timeOfDay(Number(hour)), part, `${hour}:00`);

  // The page heading and Rachna's note never disagree, at any minute of the day.
  for (let minutes = 0; minutes < 24 * 60; minutes += 30) {
    const at = new Date(Date.UTC(2026, 9, 28, 0, minutes));
    assert.equal(timeOfDay(at), rachna.timeOfDay(hourInZone(at)).toLowerCase(), at.toISOString());
  }
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
  const days = (n: number) => new Date(now.getTime() - n * DAY_MS);
  const base = { gifts: 0, giftValueUsd: 0, posts: 0, delivered: 0, noContent: 0, pending: 0, reach: 0, engagements: 0, clicks: 0, salesUsd: 0, followers: 20_000, fitScore: null, lastGiftAt: null, amazonTier: null };

  // Nobody we have gifted is "new"; a star needs two posts and 80% delivered.
  assert.equal(gradeCreator(base), "new");
  const star = { ...base, gifts: 2, posts: 3, delivered: 2, reach: 90_000, engagements: 4_500, salesUsd: 240, lastGiftAt: days(40) };
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

test("content storage only signs what it means to: exact file types, safe names, no stepping outside the folder, tamper-proof addresses", async () => {
  const { classifyFile, safeFileName, localPathFor, presignUpload, presignView, verifyLocalGrant, storageMode, isAllowedType, MAX_FILE_BYTES } = await import("@/lib/content-storage");

  // Tests run outside production, so files go to the local folder; production without bucket keys has no storage at all.
  assert.equal(storageMode(), "local");

  assert.deepEqual(classifyFile("Reel.MOV", ""), { kind: "video", contentType: "video/quicktime" });
  assert.deepEqual(classifyFile("IMG_0042.HEIC", "application/octet-stream"), { kind: "photo", contentType: "image/heic" });
  assert.deepEqual(classifyFile("clip.mp4", "video/mp4"), { kind: "video", contentType: "video/mp4" });
  // Only exact types from the fixed list are ever stored; a dressed-up type falls back to the extension or is refused.
  assert.equal(classifyFile("logo.svg", "image/svg+xml"), null, "SVG can carry script; not accepted");
  assert.equal(classifyFile("logo.svg", "image/svg+xml;charset=utf-8"), null);
  assert.equal(classifyFile("page.html", "image/png, text/html"), null);
  assert.deepEqual(classifyFile("photo.png", "image/png, text/html"), { kind: "photo", contentType: "image/png" }, "the browser text is never stored");
  assert.deepEqual(classifyFile("clip.mp4", "video/mp4,text/html"), { kind: "video", contentType: "video/mp4" });
  assert.equal(classifyFile("contract.pdf", "application/pdf"), null);
  assert.equal(isAllowedType("text/html"), false);
  assert.equal(safeFileName("../../etc/passwd"), "etc-passwd");
  assert.ok(MAX_FILE_BYTES <= 2 ** 31 - 1, "sizes fit the database column");

  assert.ok(localPathFor("content/test/cc1/a1/clip.mp4"));
  for (const bad of ["../secret", "content/../../x", "content//x", "/etc/passwd", "content/./x", "c:\\windows"]) assert.equal(localPathFor(bad), null, bad);

  // A signed upload address only works for its own method, key, size and type, and not after it expires (15 minutes).
  const upload = await presignUpload("content/test/cc1/a1/clip.mp4", "video/mp4", 1234);
  const url = new URL(upload.url, "http://portal.test");
  const key = decodeURIComponent(url.pathname.replace("/api/content-store/", ""));
  assert.equal(upload.headers["Content-Type"], "video/mp4");
  assert.ok(verifyLocalGrant(key, url.searchParams, "PUT"));
  assert.equal(verifyLocalGrant(key, url.searchParams, "GET"), null, "an upload address cannot be used to read");
  assert.equal(verifyLocalGrant("content/test/cc1/a1/other.mp4", url.searchParams, "PUT"), null, "the key is signed");
  const bigger = new URLSearchParams(url.searchParams);
  bigger.set("size", "999999999");
  assert.equal(verifyLocalGrant(key, bigger, "PUT"), null, "the size is signed");
  assert.equal(verifyLocalGrant(key, url.searchParams, "PUT", Date.now() + 20 * 60 * 1000), null, "it expires");
  const view = new URL(await presignView(key, "video/mp4", "Clip.mp4"), "http://portal.test");
  assert.equal(view.searchParams.get("dl"), "clip.mp4");
  assert.ok(verifyLocalGrant(key, view.searchParams, "GET"));
  // A stored type outside the list (only old rows could have one) is only ever offered as a download.
  const odd = new URL(await presignView(key, "text/html"), "http://portal.test");
  assert.equal(odd.searchParams.get("type"), "application/octet-stream");
  assert.ok(odd.searchParams.get("dl"));

  // The local store serves files as files: no sniffing, a sandbox, and an arrived file is never replaced.
  const route = await import("@/app/api/content-store/[...key]/route");
  const key2 = `content/test/route-${Date.now()}/a1/clip.mp4`;
  const put = await presignUpload(key2, "video/mp4", 4);
  const target = (address: string) => new URL(address, "http://portal.test").toString();
  const params = { params: Promise.resolve({ key: key2.split("/") }) };
  try {
    assert.equal((await route.PUT(new Request(target(put.url), { method: "PUT", headers: { "content-type": "text/html" }, body: "abcd" }), params)).status, 400, "the signed type must be sent");
    assert.equal((await route.PUT(new Request(target(put.url), { method: "PUT", headers: { "content-type": "video/mp4" }, body: "abcdefgh" }), params)).status, 400, "no more bytes than declared");
    assert.equal((await route.PUT(new Request(target(put.url), { method: "PUT", headers: { "content-type": "video/mp4" }, body: "abcd" }), params)).status, 200);
    assert.equal((await route.PUT(new Request(target(put.url), { method: "PUT", headers: { "content-type": "video/mp4" }, body: "wxyz" }), params)).status, 409, "a reused address cannot swap the bytes");
    const shown = await route.GET(new Request(target(await presignView(key2, "video/mp4"))), params);
    assert.equal(shown.status, 200);
    assert.equal(await shown.text(), "abcd");
    assert.equal(shown.headers.get("x-content-type-options"), "nosniff");
    assert.match(shown.headers.get("content-security-policy") ?? "", /sandbox/);
    const part = await route.GET(new Request(target(await presignView(key2, "video/mp4")), { headers: { range: "bytes=1-2" } }), params);
    assert.equal(part.status, 206);
    assert.equal(await part.text(), "bc");
  } finally {
    await rm(localPathFor(key2)!.replace(/[\\/]a1[\\/]clip\.mp4$/, ""), { recursive: true, force: true });
  }
});

test("a creator's upload link takes their files, checks what arrived, and hands the review to a person", async () => {
  const { ensureUploadUrl, startUpload, signUpload, finishUpload, loadUploadTarget, settleStaleUploads, samePostKey, UPLOAD_LINK_DAYS, UPLOAD_LINK_INACTIVE, CREATOR_LIMITS } = await import("@/lib/content-upload");
  const { localPathFor } = await import("@/lib/content-storage");
  const { refreshNextAction } = await import("@/lib/automation");
  const { campaign } = await makeUserAndCampaign("uploads", ["home decor"]);
  const creator = await makeCreator(campaign.id, "uploads_creator", { status: "content_expected" });

  // The link is made once and reused while valid; it lasts 60 days.
  const url = await ensureUploadUrl(creator.id);
  assert.match(url, /^http:\/\/portal\.test\/upload\/[A-Za-z0-9_-]{32}$/);
  assert.equal(await ensureUploadUrl(creator.id), url);
  const token = url.split("/upload/")[1];
  const link = await readCreator(creator.id);
  assert.ok(Math.abs(link.uploadExpiresAt!.getTime() - Date.now() - UPLOAD_LINK_DAYS * DAY_MS) < 60_000);
  assert.equal(await loadUploadTarget("x".repeat(32)), null, "an unknown token finds nobody");

  const base = { usage: "paid", postUrl: "https://www.instagram.com/reel/abc123/?igsh=xyz", postedOn: "2026-10-28", note: "Shot in natural light" };
  const video = { name: "Tablescape Reel.MOV", type: "", size: 2048 };
  const photo = { name: "flatlay.jpg", type: "image/jpeg", size: 512 };

  // Nothing from the browser is taken on trust.
  assert.deepEqual(await startUpload(token, { ...base, usage: "", files: [video] }), { ok: false, error: "Please choose how we may use your content." });
  assert.equal((await startUpload(token, { ...base, files: [] })).ok, false);
  assert.equal((await startUpload(token, { ...base, files: Array.from({ length: 21 }, () => photo) })).ok, false, "at most 20 files at a time");
  assert.match((await startUpload(token, { ...base, files: [{ name: "notes.pdf", type: "application/pdf", size: 10 }] }) as { error: string }).error, /not a video or photo/);
  assert.match((await startUpload(token, { ...base, files: [{ name: "x.svg", type: "image/svg+xml;charset=utf-8", size: 10 }] }) as { error: string }).error, /not a video or photo/);
  assert.match((await startUpload(token, { ...base, files: [{ ...video, size: 3_000_000_000 }] }) as { error: string }).error, /larger than 2 GB/);
  assert.match((await startUpload(token, { ...base, postUrl: "javascript:alert(1)", files: [video] }) as { error: string }).error, /post link/);
  assert.equal(await db.contentAsset.count({ where: { campaignCreatorId: creator.id } }), 0, "refused requests create nothing");

  // The team recorded the post already, copied without the tracking bits: the creator's link must not add it again.
  await db.post.create({ data: { campaignCreatorId: creator.id, socialProfileId: (await db.socialProfile.findFirstOrThrow({ where: { influencerId: creator.influencerId } })).id, url: "https://instagram.com/reel/abc123" } });
  assert.equal(samePostKey(base.postUrl), samePostKey("https://instagram.com/reel/abc123"));
  assert.notEqual(samePostKey("https://www.youtube.com/watch?v=one"), samePostKey("https://www.youtube.com/watch?v=two"));

  const started = await startUpload(token, { ...base, files: [video, photo] });
  assert.ok(started.ok);
  const assets = await db.contentAsset.findMany({ where: { campaignCreatorId: creator.id }, orderBy: { fileName: "asc" } });
  assert.deepEqual(assets.map((asset) => [asset.fileName, asset.kind, asset.status, asset.usageRights, asset.contentType]), [
    ["Tablescape Reel.MOV", "video", "uploading", "paid", "video/quicktime"],
    ["flatlay.jpg", "photo", "uploading", "paid", "image/jpeg"],
  ]);
  assert.ok(assets.every((asset) => asset.storageKey.startsWith(`content/test/${creator.id}/`)), "stored under the brand and the creator");
  // Each file's address comes on its own, just before it goes up, and only for this creator's waiting files.
  const signed = await signUpload(token, started.assetIds[0]);
  assert.ok(signed.ok && signed.headers["Content-Type"] === "video/quicktime");
  assert.equal((await signUpload(token, "someone-elses-file")).ok, false);

  // Until the bytes are really there, nothing counts as received.
  assert.deepEqual(await finishUpload(token, started.assetIds), { ok: false, error: "We could not find your files. Please try sending them again." });

  // The video lands at the declared size; the photo arrives cut short, so it does not count.
  const byName = Object.fromEntries(assets.map((asset) => [asset.fileName, asset]));
  const written: string[] = [];
  const place = async (storageKey: string, bytes: number) => {
    const file = localPathFor(storageKey)!;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.alloc(bytes));
    written.push(file);
  };
  await place(byName["Tablescape Reel.MOV"].storageKey, 2048);
  await place(byName["flatlay.jpg"].storageKey, 100);
  try {
    assert.deepEqual(await finishUpload(token, [byName["Tablescape Reel.MOV"].id]), { ok: true, received: 1, missing: 0 });
    // Reporting the same file again changes nothing.
    assert.deepEqual(await finishUpload(token, [byName["Tablescape Reel.MOV"].id]), { ok: false, error: "We could not find your files. Please try sending them again." });
    assert.deepEqual(await finishUpload(token, [byName["flatlay.jpg"].id]), { ok: false, error: "We could not find your files. Please try sending them again." });
    const after = await db.contentAsset.findMany({ where: { campaignCreatorId: creator.id }, orderBy: { fileName: "asc" } });
    assert.deepEqual(after.map((asset) => asset.status), ["received", "uploading"]);

    // The content came in: Posts to check, a person is asked to look, the move is logged, and the post is not recorded twice.
    const moved = await readCreator(creator.id);
    assert.equal(moved.status, "content_posted");
    assert.equal(moved.nextAction, "Review the creator's files");
    assert.equal(await db.post.count({ where: { campaignCreatorId: creator.id } }), 1);
    assert.equal(await db.activity.count({ where: { campaignCreatorId: creator.id, kind: "status_change" } }), 1);
    const logged = await db.activity.findFirstOrThrow({ where: { campaignCreatorId: creator.id, kind: "content_received" } });
    assert.match(logged.body, /sent 1 video through their upload link \(usage: our posts and paid ads\), with the post link/);
    assert.equal(await db.contentAsset.count({ where: { campaignCreatorId: creator.id, status: "approved" } }), 0, "nothing is approved by itself");

    // A creator cannot pile up unfinished uploads behind one link.
    const many = await startUpload(token, { ...base, files: Array.from({ length: CREATOR_LIMITS.pending }, () => photo) });
    assert.match((many as { error: string }).error ?? "", /still on their way/);

    // Asking for changes puts "tell the creator" on the list until someone writes to them.
    await db.contentAsset.updateMany({ where: { campaignCreatorId: creator.id, status: "received" }, data: { status: "changes_requested", reviewedAt: new Date(), reviewNote: "Brighter, please" } });
    await refreshNextAction(creator.id);
    assert.equal((await readCreator(creator.id)).nextAction, "Tell the creator what to change");
    await db.campaignCreator.update({ where: { id: creator.id }, data: { lastContactedAt: new Date(Date.now() + 1000) } });
    await refreshNextAction(creator.id);
    assert.equal((await readCreator(creator.id)).nextAction, "Check the post and mark completed");

    // The daily tidy-up: a file that arrived in full but was never reported is received after all; a missing one is archived.
    await db.campaignCreator.update({ where: { id: creator.id }, data: { status: "completed" } });
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    await db.contentAsset.update({ where: { id: byName["flatlay.jpg"].id }, data: { createdAt: old } });
    await place(byName["flatlay.jpg"].storageKey, 512);
    const lost = await db.contentAsset.create({ data: { campaignCreatorId: creator.id, kind: "photo", fileName: "lost.jpg", contentType: "image/jpeg", sizeBytes: 10, storageKey: `content/test/${creator.id}/lost/lost.jpg`, usageRights: "paid", createdAt: old } });
    assert.deepEqual(await settleStaleUploads(), { received: 1, archived: 1 });
    assert.equal((await db.contentAsset.findUniqueOrThrow({ where: { id: byName["flatlay.jpg"].id } })).status, "received");
    assert.equal((await db.contentAsset.findUniqueOrThrow({ where: { id: lost.id } })).archived, true);
    // New files reopen a completed collaboration, so they never sit unseen.
    const reopened = await readCreator(creator.id);
    assert.equal(reopened.status, "content_posted");
    assert.equal(reopened.nextAction, "Review the creator's files");

    // An expired link, or a creator closed out, is refused everywhere.
    await db.campaignCreator.update({ where: { id: creator.id }, data: { uploadExpiresAt: new Date(Date.now() - 1000) } });
    assert.deepEqual(await startUpload(token, { ...base, files: [photo] }), { ok: false, error: UPLOAD_LINK_INACTIVE });
    assert.deepEqual(await signUpload(token, started.assetIds[1]), { ok: false, error: UPLOAD_LINK_INACTIVE });
    assert.deepEqual(await finishUpload(token, []), { ok: false, error: UPLOAD_LINK_INACTIVE });
    const renewed = await ensureUploadUrl(creator.id);
    assert.notEqual(renewed, url, "an expired link is replaced by a new one");
    await db.campaignCreator.update({ where: { id: creator.id }, data: { status: "blacklisted" } });
    assert.equal(await loadUploadTarget(renewed.split("/upload/")[1]), null);
  } finally {
    for (const file of written) await rm(path.dirname(file), { recursive: true, force: true });
  }
});

test("Amazon's files are read by column name, however Amazon spells and formats them", async () => {
  const { headerKey, parseCount, parseMoney, parseDay, readAttributionReport, readBusinessReport, parseAttributionUrl, suggestedAdGroupName, adGroupKey, codeInAdGroup, compactGrid } = await import("@/lib/amazon-reports");

  assert.equal(headerKey("﻿(Child) ASIN"), "child asin");
  assert.equal(headerKey("Sessions – Total"), "sessions total");
  assert.equal(headerKey("Click-throughs"), "click throughs");
  assert.equal(parseCount("1,017"), 1017);
  assert.equal(parseCount("--"), null);
  assert.equal(parseMoney("$1,017.50"), 1017.5);
  assert.equal(parseMoney("Can$3.10"), 3.1);
  assert.equal(parseMoney("N/A"), null);
  for (const text of ["2026-10-28", "10/28/2026", "10/28/26", "Oct 28, 2026", "20261028"]) assert.equal(parseDay(text)?.toISOString().slice(0, 10), "2026-10-28", text);
  assert.equal(parseDay("02/30/2026"), null, "not a real day");

  // A daily Attribution report with a title line above the table and a totals row at the bottom.
  const attribution = readAttributionReport([
    ["Amazon Attribution campaign report"],
    ["Date", "Campaign", "Ad group", "Publisher", "Click-throughs", "Detail page views", "Add to carts", "Purchases", "Units sold", "Product sales"],
    ["10/27/2026", "CPC Creators Q4", "IG_@emma_k3v9x2", "Instagram", "12", "9", "3", "2", "2", "$58.00"],
    ["10/28/2026", "CPC Creators Q4", "IG_@emma_k3v9x2", "Instagram", "1,004", "700", "80", "40", "41", "$1,189.59"],
    ["", "Total", "", "", "1,016", "", "", "42", "", "$1,247.59"],
  ]);
  assert.ok(attribution.ok && attribution.daily);
  if (attribution.ok) {
    assert.equal(attribution.rows.length, 2, "the totals row is not a creator");
    assert.deepEqual([attribution.rows[1].clicks, attribution.rows[1].purchases, attribution.rows[1].productSales], [1004, 40, 1189.59]);
  }
  assert.equal(readAttributionReport([["Date", "Campaign", "Clicks"], ["10/28/2026", "x", "4"]]).ok, false, "no ad group column");
  const summary = readAttributionReport([["Ad group", "Purchases", "Total product sales"], ["TT_@nora_abc123", "3", "90"]]);
  assert.ok(summary.ok && !summary.daily, "a summary file has no dates");

  // The Business Report: renamed columns, money with symbols, one ASIN on two SKU rows.
  const business = readBusinessReport([
    ["(Parent) ASIN", "(Child) ASIN", "Title", "SKU", "Sessions – Total", "Page Views – Total", "Units Ordered", "Units Ordered – B2B", "Ordered Product Sales", "Total Order Items"],
    ["B0PARENT01", "B0TABLE001", "Tablecloth, Marigold", "CPC-TC-01", "1,200", "1,900", "30", "1", "$1,020.00", "29"],
    ["B0PARENT01", "B0TABLE001", "Tablecloth, Marigold", "CPC-TC-01-FBM", "1,200", "1,900", "2", "0", "$68.00", "2"],
    ["", "not-an-asin", "", "", "", "", "5", "", "$1", ""],
  ]);
  assert.ok(business.ok);
  if (business.ok) {
    assert.equal(business.rows.length, 1);
    assert.deepEqual([business.rows[0].unitsOrdered, business.rows[0].orderedProductSales, business.rows[0].sessions], [32, 1088, 1200], "units and sales add up, traffic does not");
  }
  assert.equal(readBusinessReport([["ASIN", "Sessions"], ["B0TABLE001", "3"]]).ok, false, "Units Ordered is required");
  // B2B units and order items add up across one ASIN's SKU rows too.
  const twoSkus = readBusinessReport([["(Child) ASIN", "Units Ordered", "Units Ordered - B2B", "Total Order Items"], ["B0TABLE001", "3", "1", "3"], ["B0TABLE001", "2", "", "2"]]);
  assert.ok(twoSkus.ok && twoSkus.rows[0].unitsOrderedB2B === 1 && twoSkus.rows[0].totalOrderItems === 5);

  // Where Amazon puts a "Total" column (which can include brand halo sales) before the plain one, the plain one wins.
  const both = readAttributionReport([["Ad group", "Total purchases", "Purchases", "Total product sales", "Product sales"], ["IG_@emma_k3v9x2", "9", "4", "$300", "$120"]]);
  assert.ok(both.ok && both.rows[0].purchases === 4 && both.rows[0].productSales === 120);

  // Before upload the browser keeps only the header on and the columns the readers use.
  const wide = [["Report title"], ["Date", "Notes", "Ad group", "Secret column", "Clicks"], ["10/28/2026", "x", "IG_@emma_k3v9x2", "y", "5"]];
  assert.deepEqual(compactGrid(wide, "attribution"), [["Ad group", "Date", "Clicks"], ["IG_@emma_k3v9x2", "10/28/2026", "5"]]);
  const compacted = readAttributionReport(compactGrid(wide, "attribution"));
  assert.ok(compacted.ok && compacted.rows[0].clicks === 5 && compacted.daily, "the compacted file reads the same");

  // Tracking links: the real tag only.
  const link = parseAttributionUrl("https://www.amazon.com/dp/B0TABLE001?maas=maas_adg_api_123_static_9_99&ref_=aa_maas&tag=maas");
  assert.ok(link.ok && link.link.asin === "B0TABLE001" && link.link.maas === "maas_adg_api_123_static_9_99");
  assert.match((parseAttributionUrl("https://amzn.to/3xyz") as { error: string }).error, /Short links/);
  assert.match((parseAttributionUrl("https://www.amazon.com/dp/B0TABLE001") as { error: string }).error, /no Amazon Attribution tag/);
  assert.match((parseAttributionUrl("https://www.amazon.com/s?k=tablecloth&maas=abc&ref_=aa_maas") as { error: string }).error, /Search-result/);
  assert.equal(parseAttributionUrl("https://www.amazon.com/stores/page/ABC?maas=m1&tag=maas").ok, true, "a Store page works");
  assert.equal(suggestedAdGroupName("instagram", "emma", "cmabcdefk3v9x2"), "IG_@emma_k3v9x2");
  assert.equal(adGroupKey("IG_@Emma_k3v9x2"), adGroupKey("ig @emma k3v9x2"));
  assert.equal(codeInAdGroup("IG_@emma_k3v9x2"), "k3v9x2");
  assert.equal(codeInAdGroup("Nora reel"), null);
});

test("Attribution imports find each creator by their ad group, never count a day twice, and list what they could not place", async () => {
  const { importAttribution } = await import("@/lib/amazon-import");
  const { attributionTotals, attributionByInfluencer, conversionRate, shareInside } = await import("@/lib/amazon-stats");
  const { creatorCode } = await import("@/lib/amazon-reports");
  const { user, campaign } = await makeUserAndCampaign("attribution", ["home decor"]);
  const emma = await makeCreator(campaign.id, "aa_emma", { status: "content_posted" });
  const nora = await makeCreator(campaign.id, "aa_nora", { status: "content_posted" });
  await db.attributionLink.create({ data: { campaignCreatorId: emma.id, url: "https://www.amazon.com/dp/B0TABLE001?maas=m_emma&ref_=aa_maas", maas: "m_emma", asin: "B0TABLE001", adGroupName: "IG_@aa_emma_x1", addedById: user.id } });
  await db.attributionLink.create({ data: { campaignCreatorId: nora.id, url: "https://www.amazon.com/dp/B0TABLE002?maas=m_nora&ref_=aa_maas", maas: "m_nora", asin: "B0TABLE002", adGroupName: "Nora reel", addedById: user.id } });
  const brandId = "test" as never;
  const header = ["Date", "Campaign", "Ad group", "Clicks", "Purchases", "Units sold", "Product sales"];

  const first = await importAttribution({
    brandId,
    userId: user.id,
    fileName: "october.xlsx",
    grid: [
      header,
      ["2026-10-01", "Q4", "ig @AA_EMMA x1", "100", "5", "5", "$150.00"], // the saved name, typed differently
      ["2026-10-01", "Q4", "IG_@aa_emma_x1", "20", "1", "1", "$30.00"], // the same day again (another publisher): adds up
      ["2026-10-02", "Q4", `TT_@aa_nora_${creatorCode(nora.id)}`, "40", "2", "2", "$60.00"], // not the saved name, but it ends in Nora's creator code
      ["2026-10-02", "Q4", "TT_@aa_nora_new", "3", "0", "0", "$0.00"], // a handle alone is never enough: nothing is guessed
      ["2026-10-02", "Q4", "Someone else", "7", "0", "0", "$0.00"],
    ],
  });
  assert.ok(first.ok);
  if (!first.ok) return;
  assert.deepEqual([first.rows, first.matchedRows, first.creators, first.from, first.to], [5, 3, 2, "2026-10-01", "2026-10-02"]);
  assert.deepEqual(first.unmatched, [{ adGroup: "Someone else", campaign: "Q4", clicks: 7, purchases: 0 }, { adGroup: "TT_@aa_nora_new", campaign: "Q4", clicks: 3, purchases: 0 }]);
  const creators = { campaignId: campaign.id };
  assert.deepEqual(await attributionTotals(creators), { clicks: 160, detailPageViews: 0, addToCarts: 0, purchases: 8, unitsSold: 8, productSales: 240, brandReferralBonus: null });

  // The same days imported again (say, a corrected file) replace what was there instead of adding to it.
  const again = await importAttribution({ brandId, userId: user.id, fileName: "october-v2.xlsx", grid: [header, ["2026-10-01", "Q4", "IG_@aa_emma_x1", "130", "7", "7", "$210.00"]] });
  assert.ok(again.ok);
  const byPerson = await attributionByInfluencer(creators);
  assert.equal(byPerson.get(emma.influencerId)?.purchases, 7, "Emma's 1 October was replaced, not added to");
  assert.equal(byPerson.get(nora.influencerId)?.purchases, 2, "Nora's 2 October was outside the new file and stays");
  assert.equal(conversionRate({ clicks: 130, purchases: 7 }), 5.4);
  assert.equal(conversionRate({ clicks: 9, purchases: 3 }), null, "too few clicks to read");

  // A period counts a day only when the whole day lies inside it.
  assert.equal((await attributionTotals(creators, { from: new Date("2026-10-02T00:00:00Z"), to: new Date("2026-10-03T00:00:00Z") })).purchases, 2);

  // A removed link keeps counting for the days it covered.
  await db.attributionLink.update({ where: { maas: "m_nora" }, data: { archived: true } });
  assert.equal((await attributionByInfluencer(creators)).get(nora.influencerId)?.purchases, 2);
  await db.attributionLink.update({ where: { maas: "m_nora" }, data: { archived: false } });

  // A summary file has no dates of its own, so the person must say which days it covers.
  const summaryGrid = [["Ad group", "Purchases", "Product sales"], ["Nora reel", "4", "$120"]];
  assert.deepEqual(await importAttribution({ brandId, userId: user.id, fileName: "summary.csv", grid: summaryGrid }), { ok: false, error: "This report has no dates, so choose the first and last day it covers." });
  const dated = await importAttribution({ brandId, userId: user.id, fileName: "summary.csv", grid: summaryGrid, from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-09-30T00:00:00Z") });
  assert.ok(dated.ok && dated.matchedRows === 1);
  assert.equal(await db.reportImport.count({ where: { brandId: "test", kind: "attribution" } }), 3);
  assert.equal(await db.activity.count({ where: { kind: "csv_import", body: { contains: "Amazon Attribution report" } } }), 3);

  // The summary is spread over its 30 days: half of September holds half of it.
  assert.equal(shareInside({ periodStart: new Date("2026-09-01T00:00:00Z"), periodEnd: new Date("2026-09-30T00:00:00Z") }, new Date("2026-09-01T00:00:00Z"), new Date("2026-09-16T00:00:00Z")), 0.5);
  assert.equal((await attributionByInfluencer(creators, { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-09-16T00:00:00Z") })).get(nora.influencerId)?.purchases, 2);
  // A daily file inside that summary would cut it in two, losing the days it does not cover: refused.
  const inside = await importAttribution({ brandId, userId: user.id, fileName: "mid-september.csv", grid: [header, ["2026-09-15", "Q4", "Nora reel", "10", "1", "1", "$30.00"]] });
  assert.match((inside as { error: string }).error, /holds one total for 2026-09-01 to 2026-09-30/);

  // Two links sharing a name name nobody; their rows are listed, never merged.
  const third = await makeCreator(campaign.id, "aa_third", { status: "content_posted" });
  await db.attributionLink.create({ data: { campaignCreatorId: third.id, url: "https://www.amazon.com/dp/B0TABLE003?maas=m_third&ref_=aa_maas", maas: "m_third", adGroupName: "Shared name", addedById: user.id } });
  await db.attributionLink.create({ data: { campaignCreatorId: emma.id, url: "https://www.amazon.com/dp/B0TABLE004?maas=m_emma2&ref_=aa_maas", maas: "m_emma2", adGroupName: "shared  NAME", addedById: user.id } });
  const shared = await importAttribution({ brandId, userId: user.id, fileName: "shared.csv", grid: [header, ["2026-11-01", "Q4", "Shared name", "5", "1", "1", "$30.00"]] });
  assert.ok(shared.ok && shared.matchedRows === 0 && shared.unmatched[0].adGroup === "Shared name");

  // A file that is the other brand's (picked under the wrong brand) is refused, not spread over look-alike names.
  const elsewhere = await db.campaign.create({ data: { name: "elsewhere", brandId: "ridhi", brief: "x", nicheKeywords: [], negativeKeywords: [] } });
  const rows: string[][] = [header];
  for (const name of ["r_one", "r_two", "r_three"]) {
    const other = await makeCreator(elsewhere.id, name);
    await db.attributionLink.create({ data: { campaignCreatorId: other.id, url: `https://www.amazon.com/dp/B0TABLE005?maas=m_${name}&ref_=aa_maas`, maas: `m_${name}`, adGroupName: `IG_@${name}_${creatorCode(other.id)}`, addedById: user.id } });
    rows.push(["2026-11-02", "Ridhi Q4", `IG_@${name}_${creatorCode(other.id)}`, "9", "1", "1", "$40.00"]);
  }
  assert.match((await importAttribution({ brandId, userId: user.id, fileName: "ridhi.csv", grid: rows }) as { error: string }).error, /belong to Ridhi Block Print/);
});

test("Business Reports give monthly units per product, replace a month when uploaded again, and refuse the other brand's file", async () => {
  const { importBusinessReport, monthFromField } = await import("@/lib/amazon-import");
  const { unitsByMonth } = await import("@/lib/amazon-stats");
  const { user, campaign } = await makeUserAndCampaign("business", ["home decor"]);
  await db.product.create({ data: { brandId: "ridhi", sku: "BR-TC-01", asin: "B0BRTABLE1", title: "Tablecloth" } });
  await db.product.create({ data: { brandId: "ridhi", sku: "BR-NP-01", asin: "B0BRNAPKN1", title: "Napkins" } });
  for (const [index, asin] of ["B0CPCOTHR1", "B0CPCOTHR2", "B0CPCOTHR3", "B0CPCOTHR4"].entries()) {
    await db.product.create({ data: { brandId: "cotton-print-club", sku: `CPC-X-${index}`, asin, title: "Quilt" } });
  }
  const october = monthFromField("2026-10", new Date("2026-10-30T00:00:00Z"))!;
  assert.equal(october.toISOString().slice(0, 10), "2026-10-01");
  assert.equal(monthFromField("2026-13"), null);
  assert.equal(monthFromField("2026-12", new Date("2026-10-30T00:00:00Z")), null, "not a future month");

  const header = ["(Child) ASIN", "Title", "SKU", "Units Ordered", "Ordered Product Sales"];
  const first = await importBusinessReport({ brandId: "ridhi", userId: user.id, fileName: "oct.csv", month: october, grid: [header, ["B0BRTABLE1", "Tablecloth", "BR-TC-01", "30", "$1,020.00"], ["B0BRNAPKN1", "Napkins", "BR-NP-01", "12", "$240.00"], ["B0UNKNOWN1", "Mystery", "", "1", "$9.99"]] });
  assert.ok(first.ok);
  if (first.ok) assert.deepEqual([first.products, first.matched, first.units, first.unmatched], [3, 2, 43, ["B0UNKNOWN1"]]);

  // The same month again replaces it: a product missing from the new file does not keep its old numbers.
  const corrected = await importBusinessReport({ brandId: "ridhi", userId: user.id, fileName: "oct-final.csv", month: october, grid: [header, ["B0BRTABLE1", "Tablecloth", "BR-TC-01", "33", "$1,122.00"]] });
  assert.ok(corrected.ok);
  assert.equal(await db.productMonthlySales.count({ where: { brandId: "ridhi", month: october } }), 1);

  // Creator links pointing at a product show their units beside the month's total.
  const creator = await makeCreator(campaign.id, "br_creator");
  await db.campaign.update({ where: { id: campaign.id }, data: { brandId: "ridhi" } });
  const link = await db.attributionLink.create({ data: { campaignCreatorId: creator.id, url: "https://www.amazon.com/dp/B0BRTABLE1?maas=m_br&ref_=aa_maas", maas: "m_br", asin: "B0BRTABLE1", adGroupName: "br", addedById: user.id } });
  const importRow = await db.reportImport.create({ data: { brandId: "ridhi", kind: "attribution", fileName: "x", periodStart: october, periodEnd: october, rows: 1, matched: 1, importedById: user.id } });
  await db.attributionStat.create({ data: { linkId: link.id, periodStart: new Date("2026-10-15T00:00:00Z"), periodEnd: new Date("2026-10-15T00:00:00Z"), unitsSold: 4, purchases: 4, productSales: 136, importId: importRow.id } });
  const table = await unitsByMonth(["ridhi"], 2, new Date("2026-10-30T00:00:00Z"));
  assert.deepEqual(table.months.map((month) => month.toISOString().slice(0, 7)), ["2026-09", "2026-10"]);
  const tablecloth = table.groups.find((group) => group.title === "Tablecloth")!;
  assert.deepEqual([tablecloth.units[1], tablecloth.sales[1], tablecloth.fromCreators[1]], [33, 1122, 4]);
  assert.equal(table.totals.units[1], 33);

  // A Cotton Print Club file uploaded as Ridhi is refused, since each brand is its own seller account.
  const wrong = await importBusinessReport({ brandId: "ridhi", userId: user.id, fileName: "cpc.csv", month: october, grid: [header, ["B0CPCOTHR1", "Quilt", "", "3", "$90"], ["B0CPCOTHR2", "Quilt", "", "3", "$90"], ["B0CPCOTHR3", "Quilt", "", "3", "$90"], ["B0CPCOTHR4", "Quilt", "", "3", "$90"]] });
  assert.deepEqual(wrong, { ok: false, error: "Most products in this file belong to Cotton Print Club, not Ridhi Block Print. Check the brand and upload it again." });
  assert.equal(await db.productMonthlySales.count({ where: { brandId: "ridhi", month: october } }), 1, "the refused file changed nothing");
});

test("one-click Amazon orders: a preview first, one order however often the button is pressed, and Amazon's answers move the creator on", async () => {
  const { sealAddress } = await import("@/lib/address-crypto");
  const { allowed } = await import("@/lib/brand-scope");
  const { previewGiftForAmazon, sendGiftToAmazon, syncAmazonOrders, cancelAtAmazon } = await import("@/lib/mcf-flow");
  const { giftReference } = await import("@/lib/gifts");
  const { mcfConfigured, addressProblems, countryCode } = await import("@/lib/mcf");
  const { user, campaign } = await makeUserAndCampaign("mcf", ["home decor"]);
  await db.campaign.update({ where: { id: campaign.id }, data: { brandId: "ridhi" } });
  const product = await db.product.create({ data: { brandId: "ridhi", sku: "BR-MCF-01", title: "Tablecloth", stock: 9 } });
  const scope = allowed({ id: user.id, brandId: null, viewBrand: null });
  const gift = async (handle: string, overrides: Record<string, string> = {}) => {
    const creator = await makeCreator(campaign.id, handle, { status: "address_collected" });
    return db.giftOrder.create({ data: { campaignCreatorId: creator.id, productId: product.id, status: "approved", ...sealAddress({ shipName: "Emma Walsh", address1: "12 Pine St", address2: null, city: "Portland", state: "or", postalCode: "97205", country: "United States", phone: null, ...overrides }) } });
  };

  // Switched on per brand: Ridhi has keys in this test, Cotton Print Club does not.
  assert.equal(mcfConfigured("ridhi"), true);
  assert.equal(mcfConfigured("cotton-print-club"), false);
  assert.equal(countryCode("United States"), "US");
  assert.deepEqual(addressProblems({ name: "x", addressLine1: "x", city: "x", postalCode: "x", countryCode: "US", stateOrRegion: "Oregon" }), ["the two-letter state"]);

  // A preview asks Amazon and changes nothing.
  const first = await gift("mcf_emma");
  const preview = await previewGiftForAmazon(first.id, scope);
  assert.ok(preview.ok);
  if (preview.ok) assert.deepEqual([preview.preview.fulfillable, preview.preview.feesUsd, preview.preview.earliestArrival], [true, 5.5, "2026-11-04T00:00:00Z"]);
  assert.equal((await db.giftOrder.findUniqueOrThrow({ where: { id: first.id } })).mcfSentAt, null);
  assert.equal(spapi.orders.size, 0, "nothing ordered by a preview");

  // Placing it: one order at Amazon under the portal's own reference, with the address Amazon needs.
  const sent = await sendGiftToAmazon(first.id, scope, user.id);
  assert.deepEqual(sent, { ok: true, reference: giftReference(first.id) });
  const placed = spapi.orders.get(giftReference(first.id))!;
  const address = placed.body.destinationAddress as Record<string, string>;
  assert.deepEqual([address.name, address.stateOrRegion, address.countryCode, placed.body.shippingSpeedCategory, placed.body.fulfillmentAction], ["Emma Walsh", "OR", "US", "Standard", "Ship"]);
  assert.deepEqual(placed.body.items, [{ sellerSku: "BR-MCF-01", sellerFulfillmentOrderItemId: `${giftReference(first.id)}-1`, quantity: 1 }]);
  let row = await db.giftOrder.findUniqueOrThrow({ where: { id: first.id } });
  assert.deepEqual([row.status, row.orderNumber], ["ordered", giftReference(first.id)]);
  // Pressing again never orders twice.
  assert.match((await sendGiftToAmazon(first.id, scope, user.id) as { error: string }).error, /already gone to Amazon/);
  assert.equal([...spapi.calls].filter((call) => call === "POST /fulfillmentOrders").length, 1);

  // A lost answer: Amazon has the order, so the portal counts it as sent rather than trying again.
  const lost = await gift("mcf_lost");
  spapi.createFails = "after-store";
  assert.ok((await sendGiftToAmazon(lost.id, scope, user.id)).ok);
  // A refusal gives the gift back, with Amazon's reason, so it can be fixed and sent again.
  const refused = await gift("mcf_refused");
  spapi.createFails = "reject";
  assert.match((await sendGiftToAmazon(refused.id, scope, user.id) as { error: string }).error, /Invalid postal code/);
  row = await db.giftOrder.findUniqueOrThrow({ where: { id: refused.id } });
  assert.deepEqual([row.mcfSentAt, row.status, row.mcfError], [null, "approved", "Invalid postal code."]);
  spapi.createFails = "";
  // An address Amazon would reject is caught before anything is sent.
  const noState = await gift("mcf_nostate", { state: "Oregon" });
  assert.match((await previewGiftForAmazon(noState.id, scope) as { error: string }).error, /two-letter state/);
  // A gift that already went to Amazon with the Amazon file is linked, never ordered again.
  const viaFile = await gift("mcf_file");
  spapi.orders.set(giftReference(viaFile.id), { status: "Planning", tracking: null, packageStatus: "IN_TRANSIT", body: {} });
  const filePreview = await previewGiftForAmazon(viaFile.id, scope);
  assert.ok(filePreview.ok && filePreview.alreadyAtAmazon);
  const postsBefore = spapi.calls.filter((call) => call === "POST /fulfillmentOrders").length;
  assert.ok((await sendGiftToAmazon(viaFile.id, scope, user.id)).ok);
  assert.equal(spapi.calls.filter((call) => call === "POST /fulfillmentOrders").length, postsBefore, "no second order placed");
  row = await db.giftOrder.findUniqueOrThrow({ where: { id: viaFile.id } });
  assert.deepEqual([row.status, row.mcfStatus], ["ordered", "Planning"], "linked with the status Amazon has, not a guess");
  // A brand without keys keeps using the Amazon file.
  await db.campaign.update({ where: { id: campaign.id }, data: { brandId: "cotton-print-club" } });
  assert.match((await previewGiftForAmazon(noState.id, scope) as { error: string }).error, /not switched on for Cotton Print Club/);
  await db.campaign.update({ where: { id: campaign.id }, data: { brandId: "ridhi" } });

  // Amazon ships it: the hourly sync records the tracking and the creator moves to "Product shipped".
  placed.tracking = "1Z999AA10123456784";
  placed.status = "Processing";
  let summary = await syncAmazonOrders();
  assert.ok(summary.shipped >= 1);
  const shippedRow = await db.giftOrder.findUniqueOrThrow({ where: { id: first.id }, include: { campaignCreator: true } });
  assert.deepEqual([shippedRow.status, shippedRow.carrier, shippedRow.trackingNumber, shippedRow.mcfStatus, shippedRow.mcfPackageNumber, shippedRow.trackingLink, shippedRow.campaignCreator.status], ["shipped", "UPS", "1Z999AA10123456784", "Processing", 7, "https://www.swiship.com/track?id=TBA1", "product_shipped"]);
  // It arrives: delivered on Amazon's date, and the content clock starts.
  placed.packageStatus = "DELIVERED";
  placed.status = "Complete";
  summary = await syncAmazonOrders();
  assert.ok(summary.delivered >= 1);
  const deliveredRow = await db.giftOrder.findUniqueOrThrow({ where: { id: first.id }, include: { campaignCreator: true } });
  assert.deepEqual([deliveredRow.status, deliveredRow.deliveredAt?.toISOString(), deliveredRow.campaignCreator.status], ["delivered", "2026-11-05T15:00:00.000Z", "content_expected"]);

  // An order Amazon gives up on becomes a problem for a person.
  spapi.orders.get(giftReference(lost.id))!.status = "Unfulfillable";
  await syncAmazonOrders();
  row = await db.giftOrder.findUniqueOrThrow({ where: { id: lost.id } });
  assert.equal(row.status, "exception");
  assert.match(row.trackingStatus ?? "", /Amazon stopped the order \(Unfulfillable\)/);

  // Cancelling asks Amazon first: allowed while it waits, refused once it is being packed.
  const waiting = await gift("mcf_cancel");
  assert.ok((await sendGiftToAmazon(waiting.id, scope, user.id)).ok);
  const cancelled = await cancelAtAmazon(waiting.id);
  assert.ok(cancelled.ok && cancelled.sentAt instanceof Date);
  assert.equal(spapi.orders.get(giftReference(waiting.id))!.status, "Cancelled");
  const packing = await gift("mcf_packing");
  assert.ok((await sendGiftToAmazon(packing.id, scope, user.id)).ok);
  spapi.orders.get(giftReference(packing.id))!.status = "Processing";
  assert.match((await cancelAtAmazon(packing.id) as { error: string }).error, /already packing/);
  // One sign-in served every call in this test.
  assert.equal(spapi.tokenCalls, 1);
});

test("one-click Amazon orders: a send cut off half-way is settled, cancel follows what Amazon has, and a person's fix is not undone", async () => {
  const { sealAddress } = await import("@/lib/address-crypto");
  const { allowed } = await import("@/lib/brand-scope");
  const { previewGiftForAmazon, sendGiftToAmazon, syncAmazonOrders, cancelAtAmazon } = await import("@/lib/mcf-flow");
  const { giftReference } = await import("@/lib/gifts");
  const { user, campaign } = await makeUserAndCampaign("mcf2", ["home decor"]);
  await db.campaign.update({ where: { id: campaign.id }, data: { brandId: "ridhi" } });
  const product = await db.product.create({ data: { brandId: "ridhi", sku: "BR-MCF-02", title: "Napkins", stock: 9 } });
  const scope = allowed({ id: user.id, brandId: null, viewBrand: null });
  const gift = async (handle: string, data: Record<string, unknown> = {}) => {
    const creator = await makeCreator(campaign.id, handle, { status: "address_collected" });
    return db.giftOrder.create({ data: { campaignCreatorId: creator.id, productId: product.id, status: "approved", ...sealAddress({ shipName: "Ada Moss", address1: "4 Elm Rd", address2: null, city: "Austin", state: "TX", postalCode: "78701", country: "US", phone: null }), ...data } });
  };
  const later = (minutes: number) => new Date(Date.now() + minutes * 60_000);
  const posts = () => spapi.calls.filter((call) => call === "POST /fulfillmentOrders").length;
  const errorOf = (result: unknown) => (result as { error?: string }).error ?? "";

  // Amazon's other way of saying "no such order" (400 InvalidInput) is read as "none", so sending still works.
  spapi.notFoundAs400 = true;
  const modern = await gift("mcf2_modern");
  const modernPreview = await previewGiftForAmazon(modern.id, scope);
  assert.ok(modernPreview.ok && !modernPreview.alreadyAtAmazon);
  assert.ok((await sendGiftToAmazon(modern.id, scope, user.id)).ok);
  spapi.notFoundAs400 = false;

  // Amazon takes the order but then stops answering: the gift stays claimed, the person is told not to send it again.
  const cut = await gift("mcf2_cut");
  spapi.createFails = "after-store-down";
  assert.match(errorOf(await sendGiftToAmazon(cut.id, scope, user.id)), /do not send it again/);
  spapi.createFails = "";
  spapi.getFails = false;
  let row = await db.giftOrder.findUniqueOrThrow({ where: { id: cut.id } });
  assert.ok(row.mcfSentAt, "the claim is kept while Amazon cannot say");
  assert.equal(row.status, "approved");
  assert.match(errorOf(await sendGiftToAmazon(cut.id, scope, user.id)), /already gone to Amazon/);
  // The check leaves it alone while a send could still be under way, then links it.
  await syncAmazonOrders(new Date());
  assert.equal((await db.giftOrder.findUniqueOrThrow({ where: { id: cut.id } })).status, "approved");
  const settled = await syncAmazonOrders(later(3));
  assert.ok(settled.linked >= 1);
  row = await db.giftOrder.findUniqueOrThrow({ where: { id: cut.id } });
  assert.deepEqual([row.status, row.orderNumber, row.mcfStatus, row.mcfError], ["ordered", giftReference(cut.id), "Received", null]);

  // Amazon unreachable from the start: nothing was ordered, so the check frees the gift to be sent again.
  const down = await gift("mcf2_down");
  spapi.getFails = true;
  const postsBefore = posts();
  assert.match(errorOf(await sendGiftToAmazon(down.id, scope, user.id)), /do not send it again/);
  assert.equal(posts(), postsBefore, "no order placed while Amazon could not be asked first");
  spapi.getFails = false;
  await syncAmazonOrders(later(3));
  row = await db.giftOrder.findUniqueOrThrow({ where: { id: down.id } });
  assert.deepEqual([row.mcfSentAt, row.status], [null, "approved"]);
  assert.match(row.mcfError ?? "", /never received/);
  assert.ok((await sendGiftToAmazon(down.id, scope, user.id)).ok, "it can be sent again");

  // An order Amazon already stopped under this reference is for a person to look at, never "Link it".
  const stopped = await gift("mcf2_stopped");
  spapi.orders.set(giftReference(stopped.id), { status: "Invalid", tracking: null, packageStatus: "IN_TRANSIT", body: {} });
  assert.match(errorOf(await previewGiftForAmazon(stopped.id, scope)), /it is invalid/);

  // Cancelled in the portal while Amazon was taking it: Amazon is asked to cancel straight away.
  const racing = await gift("mcf2_race");
  spapi.onCreate = async () => {
    await db.giftOrder.update({ where: { id: racing.id }, data: { status: "cancelled" } });
  };
  assert.match(errorOf(await sendGiftToAmazon(racing.id, scope, user.id)), /cancelled/);
  spapi.onCreate = null;
  assert.equal(spapi.orders.get(giftReference(racing.id))!.status, "Cancelled");

  // Cancel asks Amazon what it has, also for a gift sent with the Amazon file (never through the button).
  const fileWaiting = await gift("mcf2_file_wait", { status: "ordered" });
  spapi.orders.set(giftReference(fileWaiting.id), { status: "Received", tracking: null, packageStatus: "IN_TRANSIT", body: {} });
  assert.deepEqual(await cancelAtAmazon(fileWaiting.id), { ok: true, sentAt: null });
  assert.equal(spapi.orders.get(giftReference(fileWaiting.id))!.status, "Cancelled");
  const filePacking = await gift("mcf2_file_pack", { status: "ordered" });
  spapi.orders.set(giftReference(filePacking.id), { status: "Processing", tracking: null, packageStatus: "IN_TRANSIT", body: {} });
  assert.match(errorOf(await cancelAtAmazon(filePacking.id)), /already packing/);
  // Nothing at Amazon, or an order Amazon itself stopped: the portal may cancel, and Amazon is not asked to.
  const nothing = await gift("mcf2_nothing");
  assert.deepEqual(await cancelAtAmazon(nothing.id), { ok: true, sentAt: null });
  const gaveUp = await gift("mcf2_gaveup", { status: "exception" });
  spapi.orders.set(giftReference(gaveUp.id), { status: "Unfulfillable", tracking: null, packageStatus: "IN_TRANSIT", body: {} });
  assert.ok((await cancelAtAmazon(gaveUp.id)).ok);
  assert.ok(!spapi.calls.includes(`PUT /fulfillmentOrders/${giftReference(gaveUp.id)}/cancel`));
  // A returned parcel (shipped, then marked a problem) can be closed.
  const returned = await gift("mcf2_returned", { status: "exception" });
  spapi.orders.set(giftReference(returned.id), { status: "Complete", tracking: null, packageStatus: "RETURNED", body: {} });
  assert.ok((await cancelAtAmazon(returned.id)).ok);
  // Amazon cannot be reached: refused, rather than guessing.
  spapi.getFails = true;
  assert.match(errorOf(await cancelAtAmazon(nothing.id)), /could not be reached/);
  spapi.getFails = false;

  // A delivery attempt is a note, not a problem; a parcel coming back is a problem; a person's fix stays.
  const parcel = await gift("mcf2_parcel");
  assert.ok((await sendGiftToAmazon(parcel.id, scope, user.id)).ok);
  const order = spapi.orders.get(giftReference(parcel.id))!;
  Object.assign(order, { status: "Complete", tracking: "1ZPARCEL0001", packageStatus: "DELIVERY_ATTEMPTED" });
  await syncAmazonOrders(new Date(), { firstGiftId: parcel.id });
  row = await db.giftOrder.findUniqueOrThrow({ where: { id: parcel.id } });
  assert.deepEqual([row.status, row.trackingStatus, row.mcfPackageStatus, row.mcfPackageNumber], ["shipped", "In transit: delivery attempted", "DELIVERY_ATTEMPTED", order.pkg]);
  order.packageStatus = "RETURNING";
  await syncAmazonOrders(new Date(), { firstGiftId: parcel.id });
  row = await db.giftOrder.findUniqueOrThrow({ where: { id: parcel.id } });
  assert.equal(row.status, "exception");
  assert.match(row.trackingStatus ?? "", /carrier reports returning/);
  await db.giftOrder.update({ where: { id: parcel.id }, data: { status: "shipped", trackingStatus: "Carrier re-routing it" } });
  await syncAmazonOrders(new Date(), { firstGiftId: parcel.id });
  row = await db.giftOrder.findUniqueOrThrow({ where: { id: parcel.id } });
  assert.deepEqual([row.status, row.trackingStatus], ["shipped", "Carrier re-routing it"], "the same Amazon status does not raise the problem again");

  // The check keeps to its time and to brands with keys.
  assert.equal((await syncAmazonOrders(new Date(), { budgetMs: -1 })).checked, 0);
  assert.equal((await syncAmazonOrders(new Date(), { brandIds: ["cotton-print-club"] })).checked, 0);
});

test("the Invite back list offers only proven creators, and inviting one adds them as Approved with a welcome-back message, never sending anything", async () => {
  const { sealAddress } = await import("@/lib/address-crypto");
  const { allowed } = await import("@/lib/brand-scope");
  const { inviteBackList, inviteBack } = await import("@/lib/invite-back");
  const { suggestedTemplate } = await import("@/lib/next-action");
  const { pickTemplate } = await import("@/lib/channels");
  const { user, campaign: past } = await makeUserAndCampaign("invite-past", ["home decor"]);
  await db.campaign.update({ where: { id: past.id }, data: { brandId: "ridhi", status: "completed" } });
  const next = await db.campaign.create({ data: { name: "invite-next", brandId: "ridhi", brief: "Spring linens.", nicheKeywords: [], negativeKeywords: [], status: "active" } });
  const other = await db.campaign.create({ data: { name: "invite-other-live", brandId: "ridhi", brief: "Other.", nicheKeywords: [], negativeKeywords: [], status: "active" } });
  const closed = await db.campaign.create({ data: { name: "invite-closed", brandId: "ridhi", brief: "Done.", nicheKeywords: [], negativeKeywords: [], status: "completed" } });
  const cpc = await db.campaign.create({ data: { name: "invite-cpc", brandId: "cotton-print-club", brief: "CPC.", nicheKeywords: [], negativeKeywords: [], status: "active" } });
  const product = await db.product.create({ data: { brandId: "ridhi", sku: "BR-INV-01", title: "Runner", stock: 5 } });
  const scope = allowed({ id: user.id, brandId: null, viewBrand: null });

  // A past collaboration: the outcome, and as many post links as given.
  const worked = async (handle: string, status: "completed" | "no_content", posts = 1) => {
    const link = await makeCreator(past.id, handle, { status });
    const profile = await db.socialProfile.findFirstOrThrow({ where: { influencerId: link.influencerId } });
    for (let index = 0; index < posts; index++) await db.post.create({ data: { campaignCreatorId: link.id, socialProfileId: profile.id, url: `https://www.instagram.com/p/${handle}${index}/` } });
    return link;
  };
  const star = await worked("inv_star", "completed", 2);
  const good = await worked("inv_good", "completed", 1);
  const risky = await worked("inv_risky", "no_content", 0);
  const archived = await worked("inv_archived", "completed", 2);
  await db.influencer.update({ where: { id: archived.influencerId }, data: { archived: true } });
  const suppressed = await worked("inv_suppressed", "completed", 2);
  await db.suppression.create({ data: { platform: "instagram", handle: "inv_suppressed", reason: "asked us to stop" } });
  const blocked = await worked("inv_blocked", "completed", 2);
  await db.campaignCreator.create({ data: { campaignId: cpc.id, influencerId: blocked.influencerId, status: "blacklisted" } });
  const busy = await worked("inv_busy", "completed", 2);
  await db.campaignCreator.create({ data: { campaignId: other.id, influencerId: busy.influencerId, status: "contacted" } });
  // The star had a gift ten days ago: inviting is fine, a new gift waits for a person until the repeat window ends.
  const giftedAt = new Date(Date.now() - 10 * DAY_MS);
  await db.giftOrder.create({ data: { campaignCreatorId: star.id, productId: product.id, status: "delivered", createdAt: giftedAt, ...sealAddress({ shipName: "Star", address1: "1 Main St", address2: null, city: "Austin", state: "TX", postalCode: "78701", country: "US", phone: null }) } });

  // Proven only with the other brand: never offered for this brand's campaign, even to someone who sees both.
  const pastCpc = await db.campaign.create({ data: { name: "invite-past-cpc", brandId: "cotton-print-club", brief: "CPC past.", nicheKeywords: [], negativeKeywords: [], status: "completed" } });
  const cpcStar = await makeCreator(pastCpc.id, "inv_cpc_star", { status: "completed" });
  const cpcProfile = await db.socialProfile.findFirstOrThrow({ where: { influencerId: cpcStar.influencerId } });
  for (const index of [0, 1]) await db.post.create({ data: { campaignCreatorId: cpcStar.id, socialProfileId: cpcProfile.id, url: `https://www.instagram.com/p/inv_cpc_star${index}/` } });
  // Proven with both brands: only this brand's work counts here (one Ridhi post; three with Cotton Print Club).
  const both = await worked("inv_both", "completed", 1);
  const bothCpc = await db.campaignCreator.create({ data: { campaignId: pastCpc.id, influencerId: both.influencerId, status: "completed" } });
  for (const index of [0, 1, 2]) await db.post.create({ data: { campaignCreatorId: bothCpc.id, socialProfileId: (await db.socialProfile.findFirstOrThrow({ where: { influencerId: both.influencerId } })).id, url: `https://www.instagram.com/p/inv_both_cpc${index}/` } });

  const list = await inviteBackList(scope, next);
  const byId = new Map(list.map((row) => [row.id, row]));
  const mine = list.filter((row) => [star, good, risky, archived, suppressed, blocked, busy].some((link) => link.influencerId === row.id));
  // Only Stars and Good bets, never archived; those who can be invited come first, stars before good bets.
  assert.deepEqual(new Set(mine.map((row) => row.id)), new Set([star, good, suppressed, blocked, busy].map((link) => link.influencerId)));
  assert.equal(byId.has(cpcStar.influencerId), false, "a creator proven only for Cotton Print Club is not offered for a Ridhi campaign");
  assert.deepEqual([byId.get(both.influencerId)!.content, byId.get(both.influencerId)!.grade], [1, "good"], "only the Ridhi work counts for a Ridhi campaign");
  assert.equal(byId.get(star.influencerId)!.grade, "star");
  assert.equal(byId.get(good.influencerId)!.grade, "good");
  assert.deepEqual(mine.slice(0, 2).map((row) => row.id), [star.influencerId, good.influencerId]);
  assert.match(byId.get(suppressed.influencerId)!.blocked ?? "", /do-not-contact list: asked us to stop/);
  assert.equal(byId.get(blocked.influencerId)!.blocked, "Do not contact.", "a block in another brand stops the invite without naming it");
  assert.match(byId.get(busy.influencerId)!.busyIn ?? "", /invite-other-live \(Contacted\)/);
  assert.deepEqual(mine.filter((row) => row.invitable).map((row) => row.id), [star.influencerId, good.influencerId]);
  const giftAgain = byId.get(star.influencerId)!.giftAgainFrom!;
  assert.equal(Math.round((giftAgain.getTime() - giftedAt.getTime()) / DAY_MS), 90);
  assert.equal(byId.get(good.influencerId)!.giftAgainFrom, null);

  // Inviting: the proven ones join as Approved, the rest are skipped with the reason. Nothing is sent.
  const messagesBefore = await db.message.count();
  const result = await inviteBack({ campaignId: next.id, influencerIds: [star, good, suppressed, risky, busy, cpcStar].map((link) => link.influencerId), userId: user.id, scope });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.invited, 2);
    assert.deepEqual(result.skipped.map((entry) => entry.name), ["Person inv_suppressed", "A creator", "Person inv_busy", "A creator"], "the other brand's star is refused like anyone not on the list");
    assert.equal(result.skipped[1].reason, "not on the Invite back list");
  }
  const joined = await db.campaignCreator.findUniqueOrThrow({ where: { campaignId_influencerId: { campaignId: next.id, influencerId: star.influencerId } } });
  assert.deepEqual([joined.status, joined.ownerId, joined.invitedBackAt !== null, joined.nextAction], ["approved", user.id, true, "Send the welcome-back message"]);
  assert.equal(suggestedTemplate(joined.status, joined.nextAction), "welcome_back");
  assert.equal(await db.message.count(), messagesBefore, "an invite never sends or logs a message");
  assert.equal(await db.campaignCreator.count({ where: { campaignId: next.id, influencerId: risky.influencerId } }), 0);
  const logged = await db.activity.findFirstOrThrow({ where: { campaignCreatorId: joined.id, kind: "added_to_campaign" } });
  assert.match(logged.body, /Invited back to "invite-next" and approved for outreach: 2 posts delivered, 100% content rate/);
  // The log line on the Ridhi record counts Ridhi's work only.
  assert.ok((await inviteBack({ campaignId: next.id, influencerIds: [both.influencerId], userId: user.id, scope })).ok);
  const bothJoined = await db.campaignCreator.findUniqueOrThrow({ where: { campaignId_influencerId: { campaignId: next.id, influencerId: both.influencerId } } });
  assert.match((await db.activity.findFirstOrThrow({ where: { campaignCreatorId: bothJoined.id, kind: "added_to_campaign" } })).body, /: 1 post delivered, 100% content rate\.$/);
  // Once in, they show as such and cannot be invited twice.
  assert.equal((await inviteBackList(scope, next)).find((row) => row.id === star.influencerId)!.inCampaign, "Approved");
  // Someone who sees only Cotton Print Club cannot list a Ridhi campaign's creators at all.
  assert.deepEqual(await inviteBackList(allowed({ id: user.id, brandId: "cotton-print-club", viewBrand: null }), next), []);
  const again = await inviteBack({ campaignId: next.id, influencerIds: [star.influencerId], userId: user.id, scope });
  assert.ok(again.ok && again.invited === 0 && /already in this campaign/.test(again.skipped[0].reason));

  // Only open campaigns, only inside the person's brand; history from another brand does not count.
  assert.match((await inviteBack({ campaignId: closed.id, influencerIds: [good.influencerId], userId: user.id, scope }) as { error: string }).error, /is finished/);
  const cpcOnly = allowed({ id: user.id, brandId: "cotton-print-club", viewBrand: null });
  assert.deepEqual(await inviteBack({ campaignId: next.id, influencerIds: [good.influencerId], userId: user.id, scope: cpcOnly }), { ok: false, error: "That campaign is not available." });
  const crossBrand = await inviteBack({ campaignId: cpc.id, influencerIds: [good.influencerId], userId: user.id, scope: cpcOnly });
  assert.ok(crossBrand.ok && crossBrand.invited === 0 && crossBrand.skipped[0].name === "A creator", "a Ridhi creator is not named to a Cotton Print Club user");

  // The composer opens on the welcome-back template, or on the usual first message when there is none.
  const templates = [
    { id: "t1", name: "First touch", purpose: "first" },
    { id: "t2", name: "Welcome back", purpose: "welcome_back" },
  ];
  assert.equal(pickTemplate(templates, "welcome_back", "dm")?.id, "t2");
  assert.equal(pickTemplate(templates.slice(0, 1), "welcome_back", "dm")?.id, "t1");
});

test("the tidy-up offers only old work nobody touched, changes exactly what the preview showed, and its undo never undoes anyone's work", async () => {
  const { sealAddress } = await import("@/lib/address-crypto");
  const { allowed } = await import("@/lib/brand-scope");
  const { automationUserId } = await import("@/lib/automation");
  const { tidyCandidates, applyTidyChunk, undoTidyUp, tidyHistory } = await import("@/lib/tidy-up");
  const { figuresFor } = await import("@/lib/performance-stats");
  const { user, campaign } = await makeUserAndCampaign("tidy-camp", ["home decor"]);
  await db.campaign.update({ where: { id: campaign.id }, data: { brandId: "ridhi", status: "active" } });
  const other = await db.user.create({ data: { name: "Other admin", email: "tidy-other@example.com", passwordHash: "x", role: "admin" } });
  const cpc = await db.campaign.create({ data: { name: "tidy-cpc", brandId: "cotton-print-club", brief: "CPC.", nicheKeywords: [], negativeKeywords: [], status: "active" } });
  const shelved = await db.campaign.create({ data: { name: "tidy-archived", brandId: "ridhi", brief: "Old.", nicheKeywords: [], negativeKeywords: [], status: "archived" } });
  const product = await db.product.create({ data: { brandId: "ridhi", sku: "BR-TIDY-01", title: "Quilt", stock: 3 } });
  const automation = await automationUserId();
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const scope = allowed({ id: user.id, brandId: null, viewBrand: null });
  const status = async (id: string) => (await readCreator(id)).status;
  // On Home: an open link whose next step is due, in the campaign for 60 days.
  const due = (campaignId: string, handle: string, state: string, data: Record<string, unknown> = {}) =>
    makeCreator(campaignId, handle, { status: state, createdAt: ago(60), nextActionDueAt: ago(1), nextAction: "Answer the creator", waitingOn: "team", ...data });
  const line = (campaignCreatorId: string, kind: string, body: string, days: number, extra: Record<string, unknown> = {}) =>
    db.activity.create({ data: { userId: user.id, kind, campaignCreatorId, body, createdAt: ago(days), ...extra } });

  // Untouched, as the import left them: the import's own lines and the daily run are not work on the creator.
  const oldReply = await due(campaign.id, "tidy_reply", "replied");
  await line(oldReply.id, "influencer_created", "Created from the import.", 5);
  await line(oldReply.id, "note", "Imported note: loves linen", 5);
  const automationOnly = await due(campaign.id, "tidy_auto", "negotiating");
  await line(automationOnly.id, "status_change", "Moved by the daily run.", 2, { userId: automation, automated: true });
  const importedRecently = await due(campaign.id, "tidy_imported", "replied", { createdAt: ago(20) });
  // Imported through the Import screen: the lines carry the importing person's name, and still are not work on the creator.
  await line(importedRecently.id, "added_to_campaign", 'Added to campaign "tidy-camp" as Replied by CSV import.', 20);
  await line(importedRecently.id, "influencer_created", "Created by CSV import (row 4).", 20);
  const touchedLongAgo = await due(campaign.id, "tidy_long_ago", "replied");
  await db.message.create({ data: { campaignCreatorId: touchedLongAgo.id, userId: user.id, channel: "dm", direction: "outbound", body: "Hi", sentAt: ago(45) } });
  // Touched: a message, a person's status change, a person's note, a person adding them, a file review.
  const messaged = await due(campaign.id, "tidy_messaged", "replied");
  await db.message.create({ data: { campaignCreatorId: messaged.id, userId: user.id, channel: "dm", direction: "outbound", body: "Hello again", sentAt: ago(5) } });
  const moved = await due(campaign.id, "tidy_moved", "replied");
  await line(moved.id, "status_change", "Status changed by a person.", 3);
  const noted = await due(campaign.id, "tidy_noted", "replied");
  await line(noted.id, "note", "Gift order approved.", 4);
  const addedByPerson = await due(campaign.id, "tidy_added", "replied", { createdAt: ago(20) });
  await line(addedByPerson.id, "added_to_campaign", "Added to campaign.", 20);
  const brandNew = await due(campaign.id, "tidy_new", "replied", { createdAt: ago(5) });
  const notDue = await due(campaign.id, "tidy_notdue", "replied", { nextActionDueAt: new Date(now.getTime() + DAY_MS) });
  const archivedCampaign = await due(shelved.id, "tidy_shelved", "replied");
  const otherBrand = await due(cpc.id, "tidy_cpc", "replied");
  const oldFollow = await due(campaign.id, "tidy_follow", "follow_up_due", { nextAction: "Send follow-up 1" });
  const linkWaiting = await due(campaign.id, "tidy_link_wait", "interested", { nextAction: "Send the product selection link" });
  const linkSent = await due(campaign.id, "tidy_link_sent", "interested", { nextAction: "Waiting for the creator to choose a product", lastContactedAt: ago(40) });
  const oldPosted = await due(campaign.id, "tidy_posted", "content_posted", { nextAction: "Check the post and mark completed" });
  const filesWaiting = await due(campaign.id, "tidy_files", "content_posted", { nextAction: "Review the creator's files" });
  const filesReviewed = await due(campaign.id, "tidy_reviewed", "content_posted", { nextAction: "Check the post and mark completed" });
  await line(filesReviewed.id, "content_reviewed", "Approved the reel.", 1);
  // One shipment sent as two gift orders, neither tracked; and a parcel that has tracking.
  const address = sealAddress({ shipName: "Someone", address1: "1 Elm St", address2: null, city: "Austin", state: "TX", postalCode: "78701", country: "US", phone: null });
  const oldParcel = await due(campaign.id, "tidy_parcel", "product_shipped", { nextAction: "Waiting for delivery", waitingOn: "creator", nextActionDueAt: ago(30) });
  const parcelA = await db.giftOrder.create({ data: { campaignCreatorId: oldParcel.id, productId: product.id, status: "shipped", shippedAt: ago(40), createdAt: ago(41), ...address } });
  const parcelB = await db.giftOrder.create({ data: { campaignCreatorId: oldParcel.id, productId: product.id, status: "shipped", shippedAt: ago(40), createdAt: ago(40), ...address } });
  const tracked = await due(campaign.id, "tidy_tracked", "product_shipped", { nextAction: "Waiting for delivery" });
  await db.giftOrder.create({ data: { campaignCreatorId: tracked.id, productId: product.id, status: "shipped", shippedAt: ago(40), trackingNumber: "1Z999", ...address } });

  const preview = await tidyCandidates(scope, 30, now);
  const idsOf = (map: typeof preview, key: Parameters<typeof preview.get>[0]) => new Set((map.get(key) ?? []).map((row) => row.id));
  const replies = idsOf(preview, "replies");
  for (const link of [oldReply, automationOnly, importedRecently, touchedLongAgo, otherBrand]) assert.ok(replies.has(link.id), "old and untouched, whatever the import date");
  for (const link of [messaged, moved, noted, addedByPerson, brandNew, notDue, archivedCampaign]) assert.equal(replies.has(link.id), false);
  assert.ok(idsOf(preview, "followups").has(oldFollow.id));
  assert.deepEqual([...idsOf(preview, "selection")].filter((id) => [linkWaiting.id, linkSent.id].includes(id)), [linkWaiting.id], "a link sent and not used is not 'never got the link'");
  assert.ok(idsOf(preview, "posted").has(oldPosted.id) && !idsOf(preview, "posted").has(filesWaiting.id) && !idsOf(preview, "posted").has(filesReviewed.id), "files received or reviewed are real work");
  const parcelRow = preview.get("parcels")!.find((row) => row.id === oldParcel.id)!;
  assert.deepEqual(new Set(parcelRow.giftIds), new Set([parcelA.id, parcelB.id]), "every untracked parcel of the shipment");
  assert.equal(idsOf(preview, "parcels").has(tracked.id), false, "a parcel with tracking is real work");
  assert.equal(idsOf(await tidyCandidates(allowed({ id: user.id, brandId: "ridhi", viewBrand: null }), 30, now), "replies").has(otherBrand.id), false, "inside one brand, only that brand");
  const longer = await tidyCandidates(scope, 60, now);
  assert.ok(idsOf(longer, "replies").has(oldReply.id) && !idsOf(longer, "replies").has(touchedLongAgo.id), "a longer cut-off still offers never-touched work");

  // Only the choices a group offers, the listed cut-offs and small chunks; a refused call opens nothing.
  const base = { scope, userId: user.id, days: 30, tidyUpId: null };
  assert.match((await applyTidyChunk({ ...base, group: "replies", action: "close", ids: [oldReply.id] }, now) as { error: string }).error, /does not fit/);
  assert.match((await applyTidyChunk({ ...base, group: "replies", action: "leave", ids: [oldReply.id] }, now) as { error: string }).error, /does not fit/);
  assert.match((await applyTidyChunk({ ...base, days: 45, group: "replies", action: "park", ids: [oldReply.id] }, now) as { error: string }).error, /how old/);
  assert.match((await applyTidyChunk({ ...base, group: "replies", action: "park", ids: Array.from({ length: 101 }, (_, index) => `id${index}`) }, now) as { error: string }).error, /1 to 100/);
  const nothing = await applyTidyChunk({ ...base, group: "replies", action: "park", ids: [messaged.id] }, now);
  assert.ok(nothing.ok && nothing.tidyUpId === null && nothing.changed === 0, "nothing to change opens no tidy-up");
  assert.equal(await db.tidyUp.count(), 0);

  // A status chunk out of time also hands back what it did not reach, and changes nothing.
  const late = await applyTidyChunk({ ...base, group: "replies", action: "park", ids: [oldReply.id, automationOnly.id] }, now, -1);
  assert.ok(late.ok && late.changed === 0 && late.tidyUpId === null && late.pending.length === 2);
  assert.equal(await status(oldReply.id), "replied");

  // Apply: what the preview showed is parked with its next step, a forged id is skipped, all of it logged.
  const parked = await applyTidyChunk({ ...base, group: "replies", action: "park", ids: [oldReply.id, automationOnly.id, otherBrand.id, messaged.id] }, now);
  assert.ok(parked.ok && parked.tidyUpId);
  if (!parked.ok || !parked.tidyUpId) return;
  assert.deepEqual([parked.changed, parked.skipped, parked.pending], [3, 1, []]);
  let row = await readCreator(oldReply.id);
  assert.deepEqual([row.status, row.nextAction, row.nextActionDueAt], ["on_hold", "On hold: decide when to re-engage", null]);
  assert.equal(await status(messaged.id), "replied", "the messaged creator is untouched");
  assert.match((await db.activity.findFirstOrThrow({ where: { campaignCreatorId: oldReply.id, body: { startsWith: "Tidy-up" } } })).body, /^Tidy-up: status changed from Replied to On hold \(not touched since it was imported\)\.$/);
  const batch = { ...base, tidyUpId: parked.tidyUpId };
  assert.match((await applyTidyChunk({ ...batch, userId: other.id, group: "followups", action: "close", ids: [oldFollow.id] }, now) as { error: string }).error, /closed/);
  assert.ok((await applyTidyChunk({ ...batch, group: "followups", action: "close", ids: [oldFollow.id] }, now)).ok);
  row = await readCreator(oldFollow.id);
  assert.deepEqual([row.status, row.nextAction, row.nextActionDueAt], ["no_reply", null, null]);
  assert.ok((await applyTidyChunk({ ...batch, group: "selection", action: "park", ids: [linkWaiting.id] }, now)).ok);
  // A call out of time hands back what it did not reach.
  const outOfTime = await applyTidyChunk({ ...batch, group: "parcels", action: "delivered", ids: [oldParcel.id] }, now, -1);
  assert.ok(outOfTime.ok && outOfTime.changed === 0 && outOfTime.pending[0] === oldParcel.id);
  assert.equal(await status(oldParcel.id), "product_shipped", "nothing half-done");
  assert.ok((await applyTidyChunk({ ...batch, group: "parcels", action: "delivered", ids: [oldParcel.id] }, now)).ok);
  // Both parcels of the shipment are delivered a week after shipping, but the content is due today at the earliest.
  for (const gift of [parcelA, parcelB]) {
    const after = await db.giftOrder.findUniqueOrThrow({ where: { id: gift.id } });
    assert.deepEqual([after.status, after.deliveredAt?.getTime()], ["delivered", ago(40).getTime() + 7 * DAY_MS]);
  }
  row = await readCreator(oldParcel.id);
  assert.deepEqual([row.status, row.contentDueAt?.getTime()], ["content_expected", now.getTime()], "an assumed delivery never starts a clock that has run out");
  assert.notEqual(row.nextAction, "Waiting for delivery");
  assert.ok((await applyTidyChunk({ ...batch, group: "posted", action: "complete", ids: [oldPosted.id] }, now)).ok);
  assert.equal(await status(oldPosted.id), "completed");
  assert.match((await tidyHistory())[0].summary, /^3 replies parked · 1 follow-ups closed · 1 said-yes parked · 1 parcels marked delivered · 1 posts marked completed$/);
  // Housekeeping is not an event in the reports.
  assert.equal((await figuresFor({ from: ago(1), to: new Date(now.getTime() + DAY_MS) }, { id: campaign.id })).completed, 0);

  // Since then: someone moves one creator on, someone writes to a closed one, the daily run closes the parcel as No content.
  await db.campaignCreator.update({ where: { id: automationOnly.id }, data: { status: "contacted" } });
  await db.message.create({ data: { campaignCreatorId: oldFollow.id, userId: user.id, channel: "dm", direction: "outbound", body: "One more try", sentAt: new Date(Date.now() + 1000) } });
  await db.campaignCreator.update({ where: { id: oldParcel.id }, data: { status: "no_content" } });
  await db.activity.create({ data: { userId: automation, kind: "status_change", campaignCreatorId: oldParcel.id, body: "Status changed from Content expected to No content delivered.", automated: true, createdAt: new Date(Date.now() + 1000) } });

  // Undo keeps to its time budget, puts back only what nobody worked on, and brings back the original due dates.
  assert.deepEqual(await undoTidyUp({ tidyUpId: parked.tidyUpId, userId: user.id }, now, -1), { ok: true, restored: 0, kept: 0, left: 7 });
  assert.deepEqual(await undoTidyUp({ tidyUpId: parked.tidyUpId, userId: user.id }, now), { ok: true, restored: 5, kept: 2, left: 0 });
  row = await readCreator(oldReply.id);
  assert.deepEqual([row.status, row.nextAction, row.nextActionDueAt?.getTime()], ["replied", "Answer the creator", ago(1).getTime()], "exactly as late as before");
  assert.equal(await status(automationOnly.id), "contacted");
  assert.equal(await status(oldFollow.id), "no_reply", "someone wrote to them since: left as it is");
  assert.equal(await status(linkWaiting.id), "interested");
  assert.equal(await status(oldPosted.id), "content_posted");
  for (const gift of [parcelA, parcelB]) assert.deepEqual(Object.values(await db.giftOrder.findUniqueOrThrow({ where: { id: gift.id }, select: { status: true, deliveredAt: true } })), ["shipped", null]);
  row = await readCreator(oldParcel.id);
  assert.deepEqual([row.status, row.contentDueAt, row.nextAction, row.nextActionDueAt?.getTime()], ["product_shipped", null, "Waiting for delivery", ago(30).getTime()], "the automation's No content is undone with it");
  assert.match((await undoTidyUp({ tidyUpId: parked.tidyUpId, userId: user.id }, now) as { error: string }).error, /already undone/);
  assert.equal((await tidyHistory())[0].undone, true);
  // The tidy-up and its undo are not work on a creator: the same choice can be made again.
  const again = await tidyCandidates(scope, 30, now);
  assert.ok(idsOf(again, "replies").has(oldReply.id) && idsOf(again, "parcels").has(oldParcel.id) && !idsOf(again, "replies").has(automationOnly.id));
  assert.equal(await db.campaignCreator.count({ where: { id: { in: [oldReply.id, oldFollow.id, oldParcel.id] } } }), 3, "nothing is ever deleted");
});

test("the Creators table shows each creator's gifts, content, clicks and sales the same way the creator card counts them, inside the brand", async () => {
  const { creatorFiguresFor } = await import("@/lib/creator-figures");
  const { loadCreatorCard } = await import("@/lib/creator-card-data");
  const { campaignNumbers } = await import("@/lib/creator-card");
  const { allowed } = await import("@/lib/brand-scope");

  // The rule itself: Amazon's count wins once it has counted anything; otherwise the numbers typed in; otherwise nothing on file.
  const typed = [{ clicks: 40, salesUsd: 96.5 }, { clicks: null, salesUsd: 10 }];
  assert.deepEqual(campaignNumbers({ clicks: 300, purchases: 12, productSales: 480 }, typed), { clicks: 300, orders: 12, salesUsd: 480, source: "amazon" });
  assert.deepEqual(campaignNumbers({ clicks: 0, purchases: 0, productSales: 0 }, typed), { clicks: 40, orders: null, salesUsd: 106.5, source: "logged" });
  assert.deepEqual(campaignNumbers(undefined, [{ clicks: null, salesUsd: null }]), { clicks: 0, orders: null, salesUsd: 0, source: null });

  const { user, campaign: measured } = await makeUserAndCampaign("figures", ["table linens"]);
  await db.campaign.update({ where: { id: measured.id }, data: { brandId: "figures" } });
  const typedIn = await db.campaign.create({ data: { name: "figures typed", brandId: "figures", brief: "x", nicheKeywords: [], negativeKeywords: [] } });
  const otherBrand = await db.campaign.create({ data: { name: "figures other brand", brandId: "figures-other", brief: "x", nicheKeywords: [], negativeKeywords: [] } });
  const product = await db.product.create({ data: { brandId: "figures", sku: "FIG-1", title: "Tablecloth", stock: 5, price: 68 } });
  const unpriced = await db.product.create({ data: { brandId: "figures", sku: "FIG-2", title: "Napkins", stock: 5 } });

  const first = await makeCreator(measured.id, "figures_maya", { status: "completed" });
  const profileId = (await db.socialProfile.findFirstOrThrow({ where: { influencerId: first.influencerId } })).id;
  const second = await db.campaignCreator.create({ data: { campaignId: typedIn.id, influencerId: first.influencerId, status: "content_posted" } });
  const elsewhere = await db.campaignCreator.create({ data: { campaignId: otherBrand.id, influencerId: first.influencerId, status: "completed" } });
  const quiet = await makeCreator(measured.id, "figures_quiet");

  const giftAddress = { shipName: "Jane Example", address1: "1 Main St", city: "Austin", state: "TX", postalCode: "78701", country: "United States" };
  const gift = (campaignCreatorId: string, productId: string, quantity = 1, status: "delivered" | "cancelled" = "delivered") =>
    db.giftOrder.create({ data: { campaignCreatorId, productId, quantity, status, ...giftAddress } });
  await gift(first.id, product.id, 2);
  await gift(first.id, product.id, 1, "cancelled");
  await gift(second.id, unpriced.id);
  await gift(elsewhere.id, product.id, 5);

  let n = 0;
  const post = async (campaignCreatorId: string, numbers: { views?: number; clicks?: number; salesUsd?: number } | null) => {
    const row = await db.post.create({ data: { campaignCreatorId, socialProfileId: profileId, url: `https://www.instagram.com/p/figures${n++}/` } });
    if (numbers) {
      await db.metric.create({ data: { postId: row.id, views: 1, clicks: 1, salesUsd: 1, capturedAt: new Date("2026-10-01T00:00:00Z") } });
      await db.metric.create({ data: { postId: row.id, ...numbers, capturedAt: new Date("2026-10-20T00:00:00Z") } });
    }
  };
  // Typed-in numbers on the measured campaign give way to Amazon's; only the latest reading of each post counts.
  await post(first.id, { views: 10_000, clicks: 999, salesUsd: 999 });
  await post(second.id, { views: 5_000, clicks: 40, salesUsd: 96.5 });
  await post(second.id, null);
  await post(elsewhere.id, { views: 70_000, clicks: 700, salesUsd: 7_000 });

  const link = await db.attributionLink.create({ data: { campaignCreatorId: first.id, url: "https://www.amazon.com/dp/B0FIGURES1?maas=m_fig&ref_=aa_maas", maas: "m_fig", adGroupName: "fig", addedById: user.id } });
  const importRow = await db.reportImport.create({ data: { brandId: "figures", kind: "attribution", fileName: "x", periodStart: new Date("2026-10-01T00:00:00Z"), periodEnd: new Date("2026-10-31T00:00:00Z"), rows: 2, matched: 2, importedById: user.id } });
  for (const day of ["2026-10-10", "2026-10-11"]) {
    await db.attributionStat.create({ data: { linkId: link.id, periodStart: new Date(`${day}T00:00:00Z`), periodEnd: new Date(`${day}T00:00:00Z`), clicks: 150, purchases: 6, unitsSold: 6, productSales: 240, importId: importRow.id } });
  }

  const scope = allowed({ id: user.id, brandId: "figures", viewBrand: null });
  const figures = await creatorFiguresFor([first.influencerId, quiet.influencerId], scope);
  assert.deepEqual(figures.get(first.influencerId), { gifts: 2, giftValueUsd: 136, content: 3, views: 15_000, clicks: 340, orders: 12, salesUsd: 576.5 }, "the other brand's gift, post and sales stay out");
  assert.deepEqual(figures.get(quiet.influencerId), { gifts: 0, giftValueUsd: null, content: 0, views: null, clicks: null, orders: null, salesUsd: null });
  assert.deepEqual(await creatorFiguresFor([], scope), new Map());

  // The card the row opens shows the same totals.
  const card = await loadCreatorCard(first.influencerId, scope);
  assert.ok(card);
  assert.deepEqual([card.stats.gifts, card.stats.giftValueUsd, card.figures.content, card.stats.reach, card.stats.clicks, card.stats.salesUsd], [2, 136, 3, 15_000, 340, 576.5]);
  assert.deepEqual(card.campaigns.map((row) => row.numbers.source).sort(), ["amazon", "logged"]);

  // Someone who may see both brands but picked one in the sidebar: the row and the card count that brand only, alike.
  const { viewed } = await import("@/lib/brand-scope");
  const both = { id: user.id, brandId: null, viewBrand: "figures" };
  const narrowed = await creatorFiguresFor([first.influencerId], viewed(both));
  assert.deepEqual(narrowed.get(first.influencerId), figures.get(first.influencerId));
  const narrowedCard = await loadCreatorCard(first.influencerId, viewed(both));
  assert.equal(narrowedCard?.stats.gifts, 2);
  assert.equal(narrowedCard?.stats.salesUsd, 576.5);
  // With nothing picked, both brands count, in the row and the card.
  const everything = await creatorFiguresFor([first.influencerId], viewed({ ...both, viewBrand: null }));
  const fullCard = await loadCreatorCard(first.influencerId, allowed(both));
  assert.deepEqual([everything.get(first.influencerId)?.gifts, everything.get(first.influencerId)?.salesUsd], [3, 7_576.5]);
  assert.deepEqual([fullCard?.stats.gifts, fullCard?.stats.salesUsd], [3, 7_576.5]);
});

test("the CSV import says so plainly when it is given a zip, an Excel file or a sheet that is not a creator list, instead of reading garbage", async () => {
  const { parseCreatorCsv } = await import("@/lib/csv");

  // A zip (or .xlsx) read as text starts with "PK" and a control character; its bytes must not turn into "column names".
  const zip = parseCreatorCsv("PK\u0003\u0004\u0014\u0000\u0000\u0000\b\u0000cpc_shipments_all.csv���");
  assert.equal(zip.ok, false);
  if (!zip.ok) assert.match(zip.error, /zip or Excel file, not a CSV/);

  // Binary rubbish that is not a zip.
  const binary = parseCreatorCsv(`handle,platform\n${"�".repeat(20)}\u0000`);
  assert.equal(binary.ok, false);
  if (!binary.ok) assert.match(binary.error, /does not look like a text file/);

  // A real sheet that is not a creator list says what this screen is for.
  const shipments = parseCreatorCsv("Name,instagram id,order id,product link,Date\nmaya,https://instagram.com/maya,Maya P,B0TABLE001,19-Sep-26\n");
  assert.equal(shipments.ok, false);
  if (!shipments.ok) assert.match(shipments.error, /Missing required columns: handle, platform.*imports creator lists/);

  // A normal creator list still imports, with or without a byte-order mark.
  for (const prefix of ["", "﻿"]) {
    const fine = parseCreatorCsv(`${prefix}handle,platform,name\nmaya_makes,instagram,Maya\n`);
    assert.ok(fine.ok);
    if (fine.ok) assert.equal(fine.rows.length, 1);
  }
});

test("creator insights count public posts into the last 7 and 30 days and four weeks, and never invent a number a platform did not report", async () => {
  const { summariseActivity } = await import("@/lib/creator-insights");
  const now = new Date("2026-11-05T12:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const post = (days: number, likes: number | null, comments: number | null, views: number | null) => ({ postedAt: ago(days), likes, comments, views, capturedAt: ago(1) });

  assert.equal(summariseActivity([], now), null, "no posts held, no insights");

  const summary = summariseActivity([post(1, 400, 20, 9000), post(6, 200, 10, null), post(8, null, 4, null), post(29, 100, 6, 3000), post(31, 50, 1, null)], now)!;
  assert.deepEqual([summary.days7.posts, summary.days7.likes, summary.days7.comments, summary.days7.views], [2, 600, 30, 9000]);
  assert.deepEqual([summary.days30.posts, summary.days30.likes, summary.days30.comments, summary.days30.views], [4, 700, 40, 12_000], "a post of 31 days ago is outside; a hidden like count adds nothing");
  assert.deepEqual([summary.days30.avgLikes, summary.days30.avgComments, summary.days30.avgViews], [233, 10, 6000], "averages divide by the posts that reported the number");
  assert.deepEqual(summary.weeks.map((week) => week.posts), [2, 1, 0, 0], "weeks run back from now; the 29-day post is in the 30 days but in no week");
  assert.equal(summary.weeks[2].likes, null, "an empty week has no likes figure, not zero");
  assert.equal(summary.postsHeld, 5);
  assert.equal(summary.mayBeIncomplete, false);

  // Nothing reported at all stays null rather than turning into zero.
  const hidden = summariseActivity([post(2, null, null, null)], now)!;
  assert.deepEqual([hidden.days30.posts, hidden.days30.likes, hidden.days30.comments, hidden.days30.views, hidden.days30.avgLikes], [1, null, null, null, null]);

  // The fetch hit its limit and every post is inside the 30 days: there may be more than were read.
  const full = [post(1, 1, 1, null), post(2, 1, 1, null), post(3, 1, 1, null)];
  assert.equal(summariseActivity(full, now, 3)!.mayBeIncomplete, true);
  assert.equal(summariseActivity(full, now, 25)!.mayBeIncomplete, false);
  assert.equal(summariseActivity([...full, post(40, 1, 1, null)], now, 4)!.mayBeIncomplete, false, "an older post shows the 30 days were reached");
});

test("the numbers a creator sends are checked: at least one figure, whole numbers, a US share up to 100, and a real date that is not in the future", async () => {
  const { parseSuppliedInsight } = await import("@/lib/creator-insights");
  const now = new Date("2026-11-05T12:00:00Z");
  const blank = { reach7d: "", reach30d: "", profileViews30d: "", usAudiencePct: "", evidence: "", note: "", asOf: "2026-11-04" };

  const good = parseSuppliedInsight({ ...blank, reach7d: "3,200", reach30d: "12.4k", usAudiencePct: "84%", evidence: " Instagram Insights screenshot ", note: "sent by DM" }, now);
  assert.ok(good.ok);
  if (good.ok) {
    assert.deepEqual([good.value.reach7d, good.value.reach30d, good.value.profileViews30d, good.value.usAudiencePct], [3200, 12_400, null, 84]);
    assert.equal(good.value.evidence, "Instagram Insights screenshot");
    assert.equal(good.value.asOf.toISOString().slice(0, 10), "2026-11-04");
  }

  const error = (input: Partial<typeof blank>) => {
    const result = parseSuppliedInsight({ ...blank, ...input }, now);
    return result.ok ? null : result.error;
  };
  assert.match(error({}) ?? "", /at least one number/);
  assert.match(error({ reach30d: "lots" }) ?? "", /Reached, 30 days: use a whole number/);
  assert.match(error({ reach30d: "-5" }) ?? "", /use a whole number/);
  assert.match(error({ reach30d: "9999999999" }) ?? "", /use a whole number/);
  assert.match(error({ usAudiencePct: "101" }) ?? "", /percent from 0 to 100/);
  assert.match(error({ reach7d: "5", asOf: "" }) ?? "", /date the creator's figures are for/);
  assert.match(error({ reach7d: "5", asOf: "2026-02-31" }) ?? "", /date the creator's figures are for/);
  assert.match(error({ reach7d: "5", asOf: "2026-12-25" }) ?? "", /in the future/);
  assert.equal(error({ reach7d: "0" }), null, "zero is a real figure");

  const long = parseSuppliedInsight({ ...blank, reach7d: "1", evidence: "e".repeat(300), note: "n".repeat(900) }, now);
  assert.ok(long.ok);
  if (long.ok) assert.deepEqual([long.value.evidence?.length, long.value.note?.length], [120, 500]);
});

test("insights: a refresh keeps a profile's public posts once and updates them next time, falls back when Meta refuses the new fields, shows the newest creator-supplied numbers, and stays inside the person's brand", async () => {
  const { refreshPublicPosts } = await import("@/lib/public-posts");
  const { loadProfileInsights } = await import("@/lib/creator-insights-data");
  const { allowed } = await import("@/lib/brand-scope");
  const { user, campaign } = await makeUserAndCampaign("insights", ["home"]);
  const elsewhere = await db.campaign.create({ data: { name: "insights-elsewhere", brandId: "elsewhere", brief: "x", nicheKeywords: [], negativeKeywords: [] } });
  const scope = allowed({ id: user.id, brandId: "test", viewBrand: null });
  const makeProfile = async (campaignId: string, handle: string, platform: "instagram" | "youtube" = "instagram") => {
    const person = await db.influencer.create({ data: { name: `Person ${handle}`, profiles: { create: { platform, handle } } }, include: { profiles: true } });
    await db.campaignCreator.create({ data: { campaignId, influencerId: person.id } });
    return person.profiles[0];
  };

  // Instagram: five public posts, the reel with its views, a post whose like count is hidden.
  const maya = await makeProfile(campaign.id, "insight_maya");
  graphCalls.length = 0;
  const first = await refreshPublicPosts(maya.id, scope);
  assert.deepEqual(first, { ok: true, message: "Instagram @insight_maya: 5 new and 0 updated posts." });
  assert.ok(graphCalls.some((call) => decodeURIComponent(call).includes("view_count")), "the richer request was sent first");
  const held = await db.profilePost.findMany({ where: { socialProfileId: maya.id }, orderBy: { postedAt: "desc" } });
  assert.equal(held.length, 5);
  assert.deepEqual([held[0].externalId, held[0].kind, held[0].views, held[0].likes, held[0].comments], ["insight_maya-r1", "video", 9000, 400, 20]);
  assert.deepEqual([held[2].kind, held[2].likes, held[2].comments], ["carousel", null, 4], "a hidden like count stays unknown");
  // The same look again changes nothing but the readings.
  await db.profilePost.updateMany({ where: { socialProfileId: maya.id }, data: { likes: 1 } });
  assert.deepEqual(await refreshPublicPosts(maya.id, scope), { ok: true, message: "Instagram @insight_maya: 0 new and 5 updated posts." });
  assert.equal(await db.profilePost.count({ where: { socialProfileId: maya.id } }), 5, "never stored twice");
  assert.equal((await db.profilePost.findFirstOrThrow({ where: { externalId: "insight_maya-r1" } })).likes, 400, "the newer reading replaced the old one");
  assert.ok((await db.socialProfile.findUniqueOrThrow({ where: { id: maya.id } })).lastFetchedAt, "the profile records when it was read");

  // The insights are counted from what is held, newest creator-supplied figures win.
  const noon = new Date();
  const mayaInsights = (await loadProfileInsights([{ id: maya.id, platform: "instagram" }], noon)).get(maya.id)!;
  assert.deepEqual([mayaInsights.activity!.days7.posts, mayaInsights.activity!.days30.posts, mayaInsights.activity!.days30.likes, mayaInsights.activity!.days30.comments, mayaInsights.activity!.days30.views], [2, 4, 700, 40, 12_000]);
  assert.deepEqual(mayaInsights.activity!.weeks.map((week) => week.posts), [2, 1, 1, 0]);
  assert.equal(mayaInsights.supplied, null);
  await db.creatorInsight.create({ data: { socialProfileId: maya.id, addedById: user.id, reach30d: 8000, usAudiencePct: 84, evidence: "screenshot", asOf: new Date("2026-10-20T00:00:00Z") } });
  await db.creatorInsight.create({ data: { socialProfileId: maya.id, addedById: user.id, reach30d: 5000, asOf: new Date("2026-10-01T00:00:00Z") } });
  const supplied = (await loadProfileInsights([{ id: maya.id, platform: "instagram" }], noon)).get(maya.id)!.supplied!;
  assert.deepEqual([supplied.reach30d, supplied.usAudiencePct, supplied.evidence, supplied.addedBy], [8000, 84, "screenshot", "insights admin"], "the figures for the later date win, not the later entry");

  // Meta refusing the richer fields: the same request without them still gives the posts, minus reel views.
  const sam = await makeProfile(campaign.id, "norich_sam");
  graphCalls.length = 0;
  assert.deepEqual(await refreshPublicPosts(sam.id, scope), { ok: true, message: "Instagram @norich_sam: 5 new and 0 updated posts." });
  const samCalls = graphCalls.map((call) => decodeURIComponent(call)).filter((call) => call.includes("norich_sam"));
  assert.deepEqual(samCalls.map((call) => call.includes("view_count")), [true, false], "asked with the new fields, then without");
  const samPosts = await db.profilePost.findMany({ where: { socialProfileId: sam.id } });
  assert.ok(samPosts.every((row) => row.views === null && row.kind === null), "no view counts or types without the new fields");
  assert.equal(samPosts.find((row) => row.externalId === "norich_sam-r1")?.likes, 400, "likes and comments still came through");

  // YouTube: each video with its lifetime numbers; a video whose likes and comments are hidden keeps them unknown.
  const tube = await makeProfile(campaign.id, "channel/UC-many-1", "youtube");
  assert.deepEqual(await refreshPublicPosts(tube.id, scope), { ok: true, message: "YouTube channel/UC-many-1: 3 new and 0 updated posts." });
  const videos = await db.profilePost.findMany({ where: { socialProfileId: tube.id }, orderBy: { postedAt: "desc" } });
  assert.deepEqual(videos.map((row) => [row.externalId, row.kind, row.views, row.likes, row.comments]), [["many1", "video", 10_000, 500, 20], ["many2", "video", 20_000, 1000, 40], ["many3", "video", 1500, null, null]]);

  // Another brand's creator is not reachable, and a platform with no source says so.
  const stranger = await makeProfile(elsewhere.id, "insight_stranger");
  assert.deepEqual(await refreshPublicPosts(stranger.id, scope), { ok: false, error: "That profile is not one you can open." });
  assert.equal(await db.profilePost.count({ where: { socialProfileId: stranger.id } }), 0);
  const tok = await db.influencer.create({ data: { name: "Tok", profiles: { create: { platform: "tiktok", handle: "insight_tok" } } }, include: { profiles: true } });
  await db.campaignCreator.create({ data: { campaignId: campaign.id, influencerId: tok.id } });
  const refused = await refreshPublicPosts(tok.profiles[0].id, scope);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /TikTok public numbers cannot be fetched yet/);
});

test("insights: discovery keeps each new channel's recent uploads with their public numbers, and the extra video call is counted in the quota", async () => {
  const { runDiscovery } = await import("@/lib/discovery");
  // The quota test above used up the day's allowance on purpose; this test needs room.
  await db.discoveryRun.updateMany({ data: { quotaUsed: 0 } });
  const { user, campaign } = await makeUserAndCampaign("insights-discovery", ["damask"]);

  const run = await runDiscovery({ campaignId: campaign.id, source: "youtube", userId: user.id });
  assert.equal(run.added, 2);
  assert.equal(run.quotaUsed, 100 + 1 + 2 * 2, "one search, one channels call, and two calls (uploads, then video numbers) for each of two channels");
  const posts = await db.profilePost.findMany({ where: { socialProfile: { influencer: { campaigns: { some: { campaignId: campaign.id } } } } } });
  assert.equal(posts.length, 2, "each new channel kept its recent upload");
  assert.ok(posts.every((row) => row.externalId === "vid1" && row.kind === "video" && row.views === 10_000 && row.likes === 500 && row.comments === 20));
});

test("an admin deletes only a campaign with no creators, archives one that has them (keeping everything), restores it as Paused, and stays inside the brand", async () => {
  const { deleteEmptyCampaign, setCampaignArchived } = await import("@/lib/campaign-removal");
  const { allowed } = await import("@/lib/brand-scope");
  const { user, campaign: empty } = await makeUserAndCampaign("removal-empty", ["tablecloth"]);
  const admin = { userId: user.id, role: "admin", scope: allowed({ id: user.id, brandId: "test", viewBrand: null }) };

  // A test campaign: discovery was tried twice, nothing was found.
  for (const note of ["Instagram discovery is not configured: META_ACCESS_TOKEN missing.", "Instagram discovery is not configured: META_ACCESS_TOKEN missing."]) {
    await db.discoveryRun.create({ data: { campaignId: empty.id, startedById: user.id, source: "meta_free", query: {}, status: "not_configured", note } });
  }
  const before = await db.activity.count();
  assert.deepEqual(await deleteEmptyCampaign(empty.id, { ...admin, role: "marketer" }), { ok: false, error: "Only an admin can delete a campaign." });
  assert.deepEqual(await deleteEmptyCampaign(empty.id, admin), { ok: true, message: 'Deleted "removal-empty".' });
  assert.equal(await db.campaign.count({ where: { id: empty.id } }), 0);
  assert.equal(await db.discoveryRun.count({ where: { campaignId: empty.id } }), 0, "its discovery tries went with it");
  const logged = await db.activity.findFirstOrThrow({ where: { kind: "campaign_deleted" }, orderBy: { createdAt: "desc" } });
  assert.equal(logged.body, 'Deleted campaign "removal-empty". It had no creators; its 2 discovery tries went with it.');
  assert.equal(await db.activity.count(), before + 1);

  // A campaign with creators is never deleted: archive it instead, and nothing is lost.
  const { campaign: busy } = await makeUserAndCampaign("removal-busy", ["napkins"]);
  const creator = await makeCreator(busy.id, "removal_maya", { status: "product_shipped" });
  const refused = await deleteEmptyCampaign(busy.id, admin);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /has 1 creator in it, so it cannot be deleted\. Archive it instead/);
  assert.equal(await db.campaign.count({ where: { id: busy.id } }), 1);

  assert.deepEqual(await setCampaignArchived(busy.id, true, { ...admin, role: "marketer" }), { ok: false, error: "Only an admin can archive a campaign." });
  assert.equal((await setCampaignArchived(busy.id, true, admin)).ok, true);
  assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: busy.id } })).status, "archived");
  assert.equal((await db.campaignCreator.findUniqueOrThrow({ where: { id: creator.id } })).status, "product_shipped", "the creator and their stage are kept");
  assert.deepEqual(await setCampaignArchived(busy.id, true, admin), { ok: true, message: '"removal-busy" is already archived.' });
  assert.equal((await setCampaignArchived(busy.id, false, admin)).ok, true);
  assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: busy.id } })).status, "paused", "restored as Paused, so nothing restarts by itself");

  // Another brand's campaign does not exist for this admin.
  const elsewhere = await db.campaign.create({ data: { name: "removal-elsewhere", brandId: "elsewhere", brief: "x", nicheKeywords: [], negativeKeywords: [] } });
  assert.deepEqual(await deleteEmptyCampaign(elsewhere.id, admin), { ok: false, error: "That campaign is not one you can change." });
  assert.deepEqual(await setCampaignArchived(elsewhere.id, true, admin), { ok: false, error: "That campaign is not one you can change." });
  assert.equal((await db.campaign.findUniqueOrThrow({ where: { id: elsewhere.id } })).status, "draft");
});

/** Runs `work` with the Creator Marketplace settings in place, then puts the environment back. */
async function withMarketplaceEnv<T>(settings: Record<string, string | undefined>, work: () => Promise<T>): Promise<T> {
  const names = ["META_ACCESS_TOKEN", "IG_BUSINESS_ID", "META_MARKETPLACE_FIELDS", "META_RETRY_BASE_MS"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, { META_RETRY_BASE_MS: "1" });
  for (const [name, value] of Object.entries(settings)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await work();
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}
const PAGE_TOKEN = "EAAtestPAGEtoken1234567890abcdefXYZ";
const FIELDS = "username,name,biography,followers_count";

test("Creator Marketplace: reads pages with the after cursor, adds new creators as Discovered, and leaves out ids-only results, duplicates, negatives and the do-not-contact list", async () => {
  const { runDiscovery } = await import("@/lib/discovery");
  const { user, campaign } = await makeUserAndCampaign("marketplace-ok", ["table linens"]);
  await db.campaign.update({ where: { id: campaign.id }, data: { negativeKeywords: ["giveaway only"] } });
  await db.suppression.create({ data: { platform: "instagram", handle: "mk_blocked", reason: "asked us to stop" } });
  const known = await db.influencer.create({ data: { name: "Already here", profiles: { create: { platform: "instagram", handle: "mk_known" } } } });

  marketplace.mode = "ok";
  marketplace.requests.length = 0;
  const summary = await withMarketplaceEnv({ META_ACCESS_TOKEN: PAGE_TOKEN, META_MARKETPLACE_FIELDS: FIELDS }, () => runDiscovery({ campaignId: campaign.id, source: "meta_marketplace", userId: user.id }));

  assert.equal(summary.status, "completed");
  assert.deepEqual([summary.found, summary.added, summary.alreadyKnown, summary.skipped], [4, 1, 2, 2], "maya added; mk_known and maya's second appearance known; mk_blocked (do-not-contact) and mk_noah (negative keyword) skipped");
  const report = summary.report as { pages: number; creatorsSeen: number; withoutUsername: number; sampleIdsWithoutUsername: string[]; fieldsRequested: string[]; moreAvailable: boolean };
  assert.deepEqual([report.pages, report.creatorsSeen, report.withoutUsername, report.sampleIdsWithoutUsername, report.moreAvailable], [2, 6, 1, ["c2"], false]);
  assert.match(summary.note ?? "", /Not filtered by the campaign's keywords/);

  // Two requests, the second with the after cursor; the token only ever in the header.
  const calls = marketplace.requests.filter((call) => call.path.endsWith("/creator_marketplace_creators"));
  assert.equal(calls.length, 2);
  assert.equal(new URLSearchParams(calls[0].query).get("after"), null);
  assert.equal(new URLSearchParams(calls[1].query).get("after"), "AFTER1", "paged with the cursor, not paging.next");
  assert.equal(new URLSearchParams(calls[0].query).get("fields"), "id,username,name,biography,followers_count");
  assert.equal(new URLSearchParams(calls[0].query).get("limit"), "25");
  assert.ok(calls.every((call) => call.path.startsWith("v27.0/1789/") && call.auth === `Bearer ${PAGE_TOKEN}` && !call.query.includes(PAGE_TOKEN) && !/access_token/i.test(call.query)));

  // The new creator went into the normal flow: Discovered, waiting for AI scoring and a person.
  const maya = await db.socialProfile.findUniqueOrThrow({ where: { platform_handle: { platform: "instagram", handle: "mk_maya" } }, include: { influencer: { include: { campaigns: true } } } });
  assert.deepEqual([maya.source, maya.followers, maya.influencer.name, maya.influencer.campaigns[0].status], ["meta_marketplace", 12_000, "Maya Market", "discovered"]);
  assert.equal(await db.socialProfile.count({ where: { handle: { in: ["mk_blocked", "mk_noah"] } } }), 0);
  assert.equal(await db.campaignCreator.count({ where: { campaignId: campaign.id, influencerId: known.id } }), 0, "a known creator is not merged or re-added");
  assert.equal(await db.apiCall.count({ where: { service: "creator_marketplace", ok: true } }) >= 2, true);

  // Without a field list Meta returns ids only: nobody can be added, and the run says what to do.
  marketplace.requests.length = 0;
  const { campaign: idsOnly } = await makeUserAndCampaign("marketplace-ids", ["table linens"]);
  const bare = await withMarketplaceEnv({ META_ACCESS_TOKEN: PAGE_TOKEN, META_MARKETPLACE_FIELDS: undefined }, () => runDiscovery({ campaignId: idsOnly.id, source: "meta_marketplace", userId: user.id }));
  assert.deepEqual([bare.status, bare.found, bare.added], ["completed", 0, 0]);
  assert.equal(marketplace.requests.some((call) => new URLSearchParams(call.query).has("fields")), false, "no fields asked for");
  assert.match(bare.note ?? "", /returned 6 creators as ids only\. Use "Check available fields"/);
});

test("Creator Marketplace: a bad token (190), missing permission, missing settings and Meta's rate limit each stop with a clear message", async () => {
  const { runDiscovery } = await import("@/lib/discovery");
  const { user, campaign } = await makeUserAndCampaign("marketplace-errors", ["table linens"]);
  const run = (settings: Record<string, string | undefined>) => withMarketplaceEnv({ META_MARKETPLACE_FIELDS: FIELDS, ...settings }, () => runDiscovery({ campaignId: campaign.id, source: "meta_marketplace", userId: user.id }));

  // Settings missing: nothing is sent to Meta.
  marketplace.requests.length = 0;
  const none = await run({ META_ACCESS_TOKEN: "", IG_BUSINESS_ID: "1789" });
  assert.equal(none.status, "not_configured");
  assert.equal(none.note, "Instagram Creator Marketplace is not configured: META_ACCESS_TOKEN is missing.");
  const neither = await run({ META_ACCESS_TOKEN: undefined, IG_BUSINESS_ID: undefined });
  assert.equal(neither.note, "Instagram Creator Marketplace is not configured: META_ACCESS_TOKEN and IG_BUSINESS_ID are missing.");
  assert.equal(marketplace.requests.length, 0);

  // A user token instead of a Page token: Meta's code 190, not retried.
  marketplace.mode = "token";
  marketplace.requests.length = 0;
  const bad = await run({ META_ACCESS_TOKEN: PAGE_TOKEN });
  assert.equal(bad.status, "failed");
  assert.match(bad.note ?? "", /Meta refused the access token \(code 190\).*not a Page access token/);
  assert.equal(marketplace.requests.length, 1, "a bad token is not asked again");
  const logged = await db.apiCall.findFirstOrThrow({ where: { service: "creator_marketplace", errorCode: 190 }, orderBy: { createdAt: "desc" } });
  assert.deepEqual([logged.ok, logged.status], [false, 400]);

  // Missing permission.
  marketplace.mode = "permission";
  const denied = await run({ META_ACCESS_TOKEN: PAGE_TOKEN });
  assert.equal(denied.status, "failed");
  assert.match(denied.note ?? "", /does not have permission .*\(code 10\)/);

  // Rate limit once: waited and asked again, and the run completes.
  marketplace.mode = "rate-once";
  marketplace.rateOnceDone = false;
  marketplace.requests.length = 0;
  const recovered = await run({ META_ACCESS_TOKEN: PAGE_TOKEN });
  assert.equal(recovered.status, "completed");
  assert.equal(marketplace.requests.filter((call) => call.status === 429).length, 1);

  // Rate limit every time: three tries, then the run stops as "quota reached" and keeps nothing half-done.
  marketplace.mode = "rate-always";
  marketplace.requests.length = 0;
  const limited = await run({ META_ACCESS_TOKEN: PAGE_TOKEN });
  assert.equal(limited.status, "stopped_quota");
  assert.match(limited.note ?? "", /Meta's rate limit was reached/);
  assert.equal(marketplace.requests.length, 3, "three attempts with growing waits");
  assert.equal(limited.quotaUsed, 3, "the run's API calls count every request Meta received");

  // A rate limit sent as HTTP 403 is still a rate limit: retried, then "quota reached", not a permission error.
  marketplace.mode = "rate-403";
  marketplace.requests.length = 0;
  const limited403 = await run({ META_ACCESS_TOKEN: PAGE_TOKEN });
  assert.equal(limited403.status, "stopped_quota");
  assert.doesNotMatch(limited403.note ?? "", /permission/);
  assert.equal(marketplace.requests.length, 3);

  // Meta asks for a 60-second wait, longer than a slice may take: no early retry, the run stops and says why.
  marketplace.mode = "retry-after-long";
  marketplace.requests.length = 0;
  const later = await run({ META_ACCESS_TOKEN: PAGE_TOKEN });
  assert.equal(later.status, "stopped_quota");
  assert.equal(marketplace.requests.length, 1);

  // A permission code in Meta's 200-299 range, sent as HTTP 400.
  marketplace.mode = "permission-270";
  const denied270 = await run({ META_ACCESS_TOKEN: PAGE_TOKEN });
  assert.equal(denied270.status, "failed");
  assert.match(denied270.note ?? "", /does not have permission .*\(code 270\)/);

  // An unreadable "OK" answer counts as a failed request and is asked again.
  marketplace.mode = "bad-json-once";
  marketplace.rateOnceDone = false;
  marketplace.requests.length = 0;
  const unreadable = await run({ META_ACCESS_TOKEN: PAGE_TOKEN });
  assert.equal(unreadable.status, "completed");
  assert.equal(unreadable.quotaUsed, 3, "the unreadable answer, its retry, and page two");
  assert.ok(await db.apiCall.findFirst({ where: { service: "creator_marketplace", ok: false, status: 200, error: { contains: "could not be read" } } }));

  // The time budget holds the whole call, retries included.
  const { metaGraphGet, MetaGraphError } = await import("@/lib/meta-graph");
  marketplace.mode = "slow-503";
  marketplace.requests.length = 0;
  const counter = { attempts: 0 };
  const started = Date.now();
  await assert.rejects(
    withMarketplaceEnv({ META_ACCESS_TOKEN: PAGE_TOKEN }, () => metaGraphGet(PAGE_TOKEN, "1789/creator_marketplace_creators", {}, { service: "creator_marketplace", label: "the list", budgetMs: 500, timeoutMs: 400, counter })),
    (error: unknown) => error instanceof MetaGraphError && error.kind === "server",
  );
  assert.ok(Date.now() - started < 1_000, "no attempt started that the budget could not cover");
  assert.equal(counter.attempts, 1);
  marketplace.mode = "ok";
});

test("Creator Marketplace: the token never appears in logs, stored runs, the request log, activity, field checks or the admin status, even when Meta echoes it back", async () => {
  const { runDiscovery, startDiscovery, discoverySlice } = await import("@/lib/discovery");
  const { checkMarketplaceFields } = await import("@/lib/fetching/adapters/creator-marketplace");
  const { marketplaceStatus } = await import("@/lib/marketplace-status");
  const { user, campaign } = await makeUserAndCampaign("marketplace-secret", ["table linens"]);

  // Between slices the run keeps its cursor: Meta's paging.next (which carries the token) must not be in it.
  marketplace.echoToken = true;
  marketplace.mode = "ok";
  const midway = await withMarketplaceEnv({ META_ACCESS_TOKEN: PAGE_TOKEN, META_MARKETPLACE_FIELDS: FIELDS }, async () => {
    const first = await startDiscovery({ campaignId: campaign.id, source: "meta_marketplace", userId: user.id });
    assert.equal(first.done, false, "a second page is waiting");
    const row = await db.discoveryRun.findUniqueOrThrow({ where: { id: first.runId } });
    await discoverySlice(first.runId);
    return JSON.stringify([first, row]);
  });
  assert.ok(midway.includes("AFTER1"), "the cursor is kept between slices");
  assert.equal(midway.includes(PAGE_TOKEN), false, "no token in the stored run or the summary between slices");
  assert.equal(/access_token=/i.test(midway), false, "no paging.next link kept");

  const printed: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const name of ["log", "error", "warn", "info"] as const) console[name] = (...args: unknown[]) => printed.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  marketplace.echoToken = true;
  let results: unknown[];
  try {
    results = await withMarketplaceEnv({ META_ACCESS_TOKEN: PAGE_TOKEN, META_MARKETPLACE_FIELDS: FIELDS }, async () => {
      marketplace.mode = "ok";
      const good = await runDiscovery({ campaignId: campaign.id, source: "meta_marketplace", userId: user.id });
      const fields = await checkMarketplaceFields();
      marketplace.mode = "token";
      const bad = await runDiscovery({ campaignId: campaign.id, source: "meta_marketplace", userId: user.id });
      marketplace.mode = "server-echo";
      const broken = await runDiscovery({ campaignId: campaign.id, source: "meta_marketplace", userId: user.id });
      const status = await marketplaceStatus();
      return [good, fields, bad, broken, status];
    });
  } finally {
    Object.assign(console, original);
    marketplace.echoToken = false;
    marketplace.mode = "ok";
  }

  const [good, fields, bad, broken, status] = results as [{ status: string }, { ok: boolean; fields?: string[] }, { status: string; note: string | null }, { status: string; note: string | null }, { lastError: { message: string } | null; requestsLastHour: number; configured: boolean }];
  assert.equal(good.status, "completed");
  assert.deepEqual(fields, { ok: true, fields: ["biography", "followers_count", "name", "username"], creatorId: "c1" }, "field names only, never values");
  assert.equal(bad.status, "failed");
  assert.match(bad.note ?? "", /code 190/);
  assert.equal(broken.status, "failed");
  assert.equal(status.configured, true);
  assert.ok(status.requestsLastHour > 0);
  assert.ok(status.lastError);

  const stored = JSON.stringify([
    await db.discoveryRun.findMany({ where: { campaignId: campaign.id } }),
    await db.apiCall.findMany(),
    await db.activity.findMany({ where: { body: { contains: "marketplace-secret" } } }),
  ]);
  const everything = [JSON.stringify(results), stored, printed.join("\n")];
  for (const [index, text] of everything.entries()) {
    assert.equal(text.includes(PAGE_TOKEN), false, `token found in ${["the returned results", "the database", "the console"][index]}`);
    assert.equal(/access_token=(?!\[hidden\])/i.test(text), false, `an access_token query string found in ${["the returned results", "the database", "the console"][index]}`);
  }
  assert.match(stored, /\[hidden/, "Meta's echo was replaced, not stored");
  assert.ok(marketplace.requests.every((call) => !call.query.includes(PAGE_TOKEN)), "the token was never put in a URL");
});

test("a creator who confirms their gift sees the thank-you, not a re-render of their spent link; uploads and the Amazon file stay clean too", async () => {
  // Revalidating from a Server Action makes Next.js re-render the caller's own page. On /select/<token> the
  // token is spent the moment the choice is recorded, so that re-render said "This link is no longer active"
  // to every creator who had just confirmed (found 2026-11-12 on the local copy; the order itself was saved).
  const code = readFileSync("src/actions/selection.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.equal(/\brevalidate(Path|Tag)\s*\(/.test(code), false, "the creator's confirm action revalidates nothing");
  assert.equal(/\bredirect\s*\(/.test(code), false, "and sends the creator nowhere");
  assert.match(code, /message: "Thank you! Your choice is in\./, "the thank-you comes back as the action's answer");
  // The same applies to the creator's upload page: a revalidate per finished file re-rendered /upload/<token>
  // each time and used up its 60-views-in-10-minutes allowance mid-upload. The form refreshes once per batch.
  const upload = readFileSync("src/actions/content-upload.ts", "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.equal(/\brevalidate(Path|Tag)\s*\(/.test(upload), false, "the creator's upload actions revalidate nothing");
  assert.match(readFileSync("src/app/upload/[token]/upload-form.tsx", "utf8"), /if \(arrived\.size > 0\) router\.refresh\(\);/, "one refresh per batch, not per file");

  // The Amazon file: a phone typed as "+1 ..." must not reach Amazon as "'+1 ..." (the spreadsheet formula guard).
  const { amazonPhoneNumber } = await import("@/lib/gifts");
  const { csvCell } = await import("@/lib/csv-out");
  assert.equal(csvCell(amazonPhoneNumber("+1 512-555-0100")), "1 512-555-0100");
  assert.equal(csvCell(amazonPhoneNumber(" + 44 20 7946 0000")), "44 20 7946 0000");
  assert.equal(csvCell(amazonPhoneNumber("(512) 555-0100")), "(512) 555-0100");
  assert.equal(amazonPhoneNumber(""), null);
  assert.equal(amazonPhoneNumber(null), null);
  assert.match(readFileSync("src/app/(app)/orders/export/route.ts", "utf8"), /AddressPhoneNumber: amazonPhoneNumber\(order\.phone\)/, "the Amazon file uses it");

  // The link is still spent: the same address never answers twice.
  const { recordSelection } = await import("@/lib/selection-flow");
  const { campaign } = await makeUserAndCampaign("thank-you", ["tablecloth"]);
  const product = await db.product.create({ data: { brandId: "test", sku: "T-THANKS", title: "Tablecloth", color: "Sage", amazonUrl: "https://www.amazon.com/dp/B0THANKS01" } });
  const link = await makeCreatorWithLink(campaign.id, "sel_thanks", "token-thank-you", { status: "agreed" });
  assert.equal((await recordSelection("token-thank-you", product.id, usAddress())).ok, true);
  const spent = await readCreator(link.id);
  assert.equal(spent.selectionToken, null, "the token is dropped once used");
  assert.ok(spent.selectionUsedAt);
  assert.equal((await recordSelection("token-thank-you", product.id, usAddress())).ok, false, "a second answer is refused");
});

test("Sign out is a plain request to /logout that deletes the session cookie, never a Server Action", () => {
  // On the live site (2026-11-12) the Server Action sign-out left people signed in and crashed the page
  // ("An unexpected response was received from the server"), so nobody could switch accounts.
  const shell = readFileSync("src/components/app-shell.tsx", "utf8");
  assert.match(shell, /<form action="\/logout" method="post">/, "the account menu posts to /logout");
  assert.doesNotMatch(shell, /action=\{logout\}/, "no Server Action sign-out in the menu");
  const password = readFileSync("src/app/account/password/page.tsx", "utf8");
  assert.match(password, /<form action="\/logout" method="post">/, "the choose-a-password page can sign out too");
  const route = readFileSync("src/app/logout/route.ts", "utf8");
  assert.match(route, /export async function POST/, "/logout takes the form post");
  assert.match(route, /export async function GET/, "and keeps the GET used by requireUser");
  assert.match(route, /__Secure-\)\?authjs\\.session-token/, "every session cookie form is deleted");
  assert.match(route, /new URL\(origin\)\.host !== host/, "only the portal's own pages may post it");
  assert.match(route, /secure: name\.startsWith\("__Secure-"\)/, "a __Secure- cookie is expired with a Secure Set-Cookie, or the browser ignores it");
  assert.match(readFileSync("src/middleware.ts", "utf8"), /\|logout\|/, "the middleware stays off /logout, so it cannot re-issue the session it is ending");
  assert.doesNotMatch(readFileSync("src/actions/auth.ts", "utf8"), /signOut/, "no sign-out left in the Server Actions");
});

test("Initials and clipped bios never split an emoji or a styled letter (React error 418 on real names)", async () => {
  const { initials } = await import("@/components/avatar");
  const { clip } = await import("@/lib/fetching/adapters/shared");
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const name of ["𝓐𝓷𝓷𝓪 𝓡𝓸𝔂", "𝐀𝐧𝐧𝐚", "🌸 Priya Home", "Ava Patel", "ava", "🌸🌸"]) {
    const out = initials(name);
    assert.doesNotMatch(out, lone, `initials of ${JSON.stringify(name)} must be whole characters`);
  }
  assert.equal(initials("Ava Patel"), "AP");
  assert.equal(initials("𝓐𝓷𝓷𝓪 𝓡𝓸𝔂"), "𝓐𝓡");
  const bio = `${"a".repeat(8)}𝓐𝓷𝓷𝓪`;
  for (let max = 2; max <= bio.length; max++) assert.doesNotMatch(clip(bio, max), lone, `clip at ${max} must not leave half a letter`);
  const shell = readFileSync("src/components/app-shell.tsx", "utf8");
  assert.match(shell, /Array\.from\(part\)\[0\]/, "the account badge takes whole characters too");
});

test("Dark theme: every colour token has a dark value, the theme is set before paint, light by default; the portal is called Creator Setu", async () => {
  const css = readFileSync("src/app/globals.css", "utf8");
  const block = (selector: string) => [...css.matchAll(new RegExp(`${selector.replace(/[[\]()"=]/g, "\$&")}\s*\{([^}]*)\}`, "g"))].map((m) => m[1]).join("\n");
  const names = (text: string) => new Set([...text.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const light = names(block(":root"));
  const dark = names(block(':root[data-theme="dark"]'));
  const missing = [...light].filter((name) => !dark.has(name));
  assert.deepEqual(missing, [], "every light colour token needs a dark value");
  const { THEME_SCRIPT, THEME_KEY } = await import("@/lib/theme");
  assert.ok(THEME_SCRIPT.includes(`localStorage.getItem("${THEME_KEY}")`), "the early script reads the key the switch writes");
  assert.match(THEME_SCRIPT, /"light"/, "anyone who never chose sees light (and so do creators on their gift and upload pages)");
  const layout = readFileSync("src/app/layout.tsx", "utf8");
  assert.match(layout, /<head>\s*<script dangerouslySetInnerHTML=\{\{ __html: THEME_SCRIPT \}\} \/>/, "the theme is applied in <head>, before the page paints");
  assert.match(layout, /data-theme="light" suppressHydrationWarning/);
  const leftovers = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return leftovers(file);
    return /\.(tsx?|js|webmanifest|svg)$/.test(entry.name) && /Creator Growth/.test(readFileSync(file, "utf8")) ? [file] : [];
  });
  assert.deepEqual([...leftovers("src"), ...leftovers("public")], [], "the old name is gone from everything people see");
});

test("Message window: Product type, then the exact product by its real name, only from the campaign brand; {product} gets colour and type", async () => {
  const { productPhrase, productLabel, distinctLabels, fillTemplate } = await import("@/lib/template");
  assert.equal(productPhrase({ title: "Pillow Cover", color: "Aquamarine Blue" }), "our Aquamarine Blue Pillow Cover");
  assert.equal(productPhrase({ title: " Tablecloth ", color: null }), "our Tablecloth");
  assert.equal(productPhrase({ title: "", color: null }), "");
  const ruffle = { title: "Pillow Cover", color: "Aquamarine Blue", size: "20\" x 20\" (Pack of 2)", listingName: "Ridhi Block Print Aquamarine Blue Throw Pillow Cover 20\" x 20\" (Pack of 2) Decorative Cushion Covers with Ruffle for Couch, Sofa, Bed" };
  const plain = { ...ruffle, listingName: "Ridhi Aqua Blue Hand Block Print Throw Pillow Covers 20x20 Inch Set 2" };
  assert.equal(productLabel(plain), 'Aqua Blue Hand Block Print Throw Pillow Covers 20x20 Inch Set 2 · 20" x 20" (Pack of 2)', "brand word dropped, size at the end");
  assert.notEqual(productLabel(ruffle), productLabel(plain), "two pieces of the same colour and size can be told apart");
  assert.ok(!productLabel(ruffle).includes(","), "the keyword tail after the first comma is cut");
  assert.ok(productLabel(ruffle).endsWith('· 20" x 20" (Pack of 2)'), "the size always shows, even when the name is shortened");
  const round = (size: string) => ({ title: "Tablecloth", color: "Amber Marigold", size, listingName: "Ridhi Amber Marigold Block Print Round Tablecloth, Gift" });
  assert.notEqual(productLabel(round('110" (Round)')), productLabel(round('120" (Round)')), "sizes of one print never look the same");
  const twins = distinctLabels([{ label: "Same", sku: "A-1" }, { label: "Same", sku: "A-2" }, { label: "Other", sku: "B-1" }]);
  assert.deepEqual(twins.map((t) => t.label), ["Same · A-1", "Same · A-2", "Other"], "still-identical names get their SKU");
  assert.equal(productLabel({ title: "Napkins", color: "Sage", size: "Set of 4", listingName: null }), "Sage · Napkins · Set of 4");
  const vars = { name: "Maya", handle: "", platform: "Instagram", sender: "Khushi", product: productPhrase(ruffle), brand: "", selection_link: "", upload_link: "", amazon_link: "" };
  assert.equal(fillTemplate("Just following up about gifting you {product}.", vars), "Just following up about gifting you our Aquamarine Blue Pillow Cover.");
  const action = readFileSync("src/actions/messages.ts", "utf8");
  assert.ok(action.includes('db.product.groupBy({ by: ["title"], where: { brandId, giftable: true, archived: false }'), "types: one brand only, giftable and live");
  assert.ok(action.includes("where: { brandId: sendable.creator.campaign.brandId, title: type, giftable: true, archived: false }"), "products: the creator's campaign brand only, giftable and live");
  const fn = action.slice(action.indexOf("export async function productsForMessage"));
  assert.ok(fn.indexOf("requireUser()") > 0 && fn.indexOf("loadSendable(campaignCreatorId, allowed(user))") > 0 && fn.indexOf("loadSendable(") < fn.indexOf("db.product.findMany"), "signed in, and only for a creator this person may message, before any product is read");
  const dialog = readFileSync("src/components/message-button.tsx", "utf8");
  assert.ok(/<NativeSelect\s+id="msg-product-type"/.test(dialog), "the type is a dropdown");
  assert.ok(/<NativeSelect\s+id="msg-product"\s/.test(dialog), "the exact product is a dropdown");
  assert.ok(dialog.includes("Other (type it)"), "free text stays possible");
});

test("automatic Amazon orders: off by default, only brands with keys an admin switched on, after the hold, within the 24-hour cap, and never twice", async () => {
  const { sealAddress } = await import("@/lib/address-crypto");
  const { autoSendApprovedGifts } = await import("@/lib/mcf-auto");
  const { giftReference } = await import("@/lib/gifts");
  const { campaign } = await makeUserAndCampaign("mcfauto", ["home decor"]);
  await db.campaign.update({ where: { id: campaign.id }, data: { brandId: "ridhi" } });
  const product = await db.product.create({ data: { brandId: "ridhi", sku: "BR-AUTO-01", title: "Tablecloth", stock: 9 } });
  const now = new Date();
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const gift = async (handle: string, approvedAt: Date | null, status: "approved" | "needs_approval" = "approved") => {
    const creator = await makeCreator(campaign.id, handle, { status: "address_collected" });
    return db.giftOrder.create({ data: { campaignCreatorId: creator.id, productId: product.id, status, approvedAt, ...sealAddress({ shipName: "Ava Auto", address1: "1 Elm St", address2: null, city: "Austin", state: "tx", postalCode: "78701", country: "United States", phone: null }) } });
  };
  const sentRefs = () => [...spapi.orders.keys()];
  const before = sentRefs().length;

  // Off by default: an approved gift long past any hold is not touched.
  const old = await gift("auto_old", ago(600));
  assert.deepEqual(await autoSendApprovedGifts(now), { brands: 0, sent: 0, leftForPerson: 0, failed: 0, capped: 0 });
  assert.equal(sentRefs().length, before, "nothing is ordered while the switch is off");

  // Switched on for Ridhi (which has keys in this test) with a 30-minute hold, and room for exactly 3 more today:
  // the cap counts every Ridhi order of the last 24 hours, including the button sends made by the tests above.
  const sentToday = await db.giftOrder.count({ where: { mcfSentAt: { gte: ago(24 * 60) }, campaignCreator: { campaign: { brandId: "ridhi" } } } });
  const cap = sentToday + 3;
  await db.brandSettings.upsert({ where: { brandId: "ridhi" }, update: { mcfAutoSend: true, mcfAutoHoldMinutes: 30, mcfAutoDailyCap: cap }, create: { brandId: "ridhi", mcfAutoSend: true, mcfAutoHoldMinutes: 30, mcfAutoDailyCap: cap } });
  // Cotton Print Club has no keys here: even switched on, nothing of it can go.
  await db.brandSettings.upsert({ where: { brandId: "cotton-print-club" }, update: { mcfAutoSend: true }, create: { brandId: "cotton-print-club", mcfAutoSend: true } });
  const fresh = await gift("auto_fresh", ago(5));
  const waiting = await gift("auto_waiting", ago(400), "needs_approval");
  const second = await gift("auto_second", ago(300));
  const third = await gift("auto_third", ago(200));
  const fourth = await gift("auto_fourth", ago(100));

  const run = await autoSendApprovedGifts(now);
  assert.deepEqual([run.brands, run.sent, run.capped], [1, 3, 1], "one brand, three sent (the cap), one held back by the cap");
  for (const g of [old, second, third]) assert.ok(spapi.orders.has(giftReference(g.id)), "the oldest approvals go first");
  assert.ok(!spapi.orders.has(giftReference(fourth.id)), "over the cap: waits for the next 24 hours");
  assert.ok(!spapi.orders.has(giftReference(fresh.id)), "inside the hold: a person can still catch a mistake");
  assert.ok(!spapi.orders.has(giftReference(waiting.id)), "a gift that still needs a person's approval never goes");
  const placed = await db.giftOrder.findUniqueOrThrow({ where: { id: old.id }, select: { mcfSentAt: true, orderNumber: true } });
  assert.ok(placed.mcfSentAt && placed.orderNumber === giftReference(old.id), "linked like a button send");
  const auto = await db.user.findUniqueOrThrow({ where: { email: "automation@system.invalid" }, select: { id: true } }).catch(() => null);
  if (auto) assert.ok((await db.activity.count({ where: { userId: auto.id } })) > 0, "logged under the Automation account");

  // Running again (every tick) never orders anything twice; the cap still holds.
  const again = await autoSendApprovedGifts(now);
  assert.equal(again.sent, 0);
  assert.equal(sentRefs().length, before + 3);

  // Next day: room again, but Amazon cannot ship (no stock): both waiting gifts wait for a person with the reason.
  const tomorrow = new Date(now.getTime() + 25 * 60 * 60 * 1000);
  spapi.previewUnfulfillable = true;
  const blocked = await autoSendApprovedGifts(tomorrow);
  spapi.previewUnfulfillable = false;
  assert.deepEqual([blocked.sent, blocked.leftForPerson], [0, 2], "the one over yesterday's cap and the one past its hold");
  for (const g of [fourth, fresh]) {
    const note = await db.giftOrder.findUniqueOrThrow({ where: { id: g.id }, select: { mcfSentAt: true, mcfError: true } });
    assert.equal(note.mcfSentAt, null);
    assert.match(note.mcfError ?? "", /Not sent automatically: Amazon says it cannot ship this gift \(InventoryUnavailable\)/);
  }
  // Amazon can ship again: those two stay with a person (never retried by the automation); a new approval goes.
  const newer = await gift("auto_newer", new Date(tomorrow.getTime() - 60 * 60_000));
  const later = await autoSendApprovedGifts(tomorrow);
  assert.equal(later.sent, 1);
  assert.ok(spapi.orders.has(giftReference(newer.id)));
  for (const g of [fourth, fresh]) assert.ok(!spapi.orders.has(giftReference(g.id)), "a gift left for a person is not retried by the automation");

  // Switched off again: nothing more goes.
  await db.brandSettings.update({ where: { brandId: "ridhi" }, data: { mcfAutoSend: false } });
  await gift("auto_after_off", ago(600));
  assert.equal((await autoSendApprovedGifts(tomorrow)).sent, 0);

  // Only admins can switch it, and only for a brand with keys.
  const settings = readFileSync("src/actions/settings.ts", "utf8");
  const save = settings.slice(settings.indexOf("export async function saveAutoSend"));
  assert.ok(save.indexOf("requireAdmin()") > 0 && save.indexOf("requireAdmin()") < save.indexOf("brandSettings.upsert"), "admin only");
  assert.match(save, /if \(on && !mcfConfigured\(brandId\)\)/, "cannot be switched on without the brand's keys");
  await db.brandSettings.update({ where: { brandId: "cotton-print-club" }, data: { mcfAutoSend: false } });
});

test("Targets: messages a day per person, gifts a week for the whole brand team (default 100), counted on Home within the brand", async () => {
  const settings = await db.brandSettings.upsert({ where: { brandId: "ridhi" }, update: {}, create: { brandId: "ridhi" } });
  assert.equal(typeof settings.weeklyGiftTarget, "number");
  const { brandTargets } = await import("@/lib/outreach-stats");
  const fresh = (await brandTargets(["cotton-print-club"])).get("cotton-print-club");
  assert.ok(fresh && fresh.weeklyGifts >= 0);
  const action = readFileSync("src/actions/settings.ts", "utf8");
  assert.match(action, /const gifts = Number\(field\(formData, "weeklyGifts"\)\);/);
  assert.match(action, /for \(const value of \[daily, weekly, gifts\]\)/, "the gift target is checked like the others (0 to 1,000)");
  assert.equal((action.match(/weeklyGiftTarget: gifts/g) ?? []).length, 2, "saved on create and on update");
  const home = readFileSync("src/app/(app)/today/page.tsx", "utf8");
  assert.ok(home.includes('db.giftOrder.count({ where: { ...view.gifts, createdAt: { gte: weekStart, lt: now }, status: { not: "cancelled" } } })'), "this week's gifts, inside the brand view, cancelled ones left out");
  assert.match(home, /label="Messages today" value=\{mine\.todayMessages\} of=\{target\.daily > 0 \? target\.daily : undefined\}/, "the daily message target on Home");
  assert.match(home, /label="Gifts this week" value=\{giftsThisWeek\} of=\{giftTarget > 0 \? giftTarget : undefined\}/, "the weekly gift target on Home");
});

test("ERP: an approved gift goes to the ERP server to server (address never in a link), once, only within the brand; the ERP's report-back needs the key", async () => {
  const { sealAddress } = await import("@/lib/address-crypto");
  const { allowed } = await import("@/lib/brand-scope");
  const { sendGiftToErp, erpCallerAllowed, giftIdForReference } = await import("@/lib/erp");
  const { giftReference } = await import("@/lib/gifts");
  const received: { auth: string | undefined; body: Record<string, unknown> }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      received.push({ auth: req.headers.authorization, body });
      // Like the ERP on Google Apps Script: the key is in the body, and every answer is HTTP 200 with ok/code.
      if (body.key !== "erp-test-key") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, code: 401, error: "unauthorized" })); return; }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, reference: body.reference, url: `https://erp.example/#creators?ref=${body.reference}` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const saved = { url: process.env.ERP_ORDERS_URL, secret: process.env.ERP_SECRET };
  process.env.ERP_ORDERS_URL = `http://127.0.0.1:${port}/creator-orders`;
  process.env.ERP_SECRET = "erp-test-key";
  try {
    const { user, campaign } = await makeUserAndCampaign("erp", ["home decor"]);
    await db.campaign.update({ where: { id: campaign.id }, data: { brandId: "ridhi" } });
    const product = await db.product.create({ data: { brandId: "ridhi", sku: "BR-ERP-01", title: "Tablecloth", color: "Ruby Red", size: "60x60", stock: 5 } });
    const creator = await makeCreator(campaign.id, "erp_maya", { status: "address_collected" });
    const gift = await db.giftOrder.create({ data: { campaignCreatorId: creator.id, productId: product.id, status: "approved", approvedAt: new Date(), ...sealAddress({ shipName: "Maya Erp", address1: "12 Pine St", address2: null, city: "Portland", state: "or", postalCode: "97205", country: "United States", phone: "5035550100" }) } });
    const both = allowed({ id: user.id, brandId: null, viewBrand: null });
    const cpcOnly = allowed({ id: user.id, brandId: "cotton-print-club", viewBrand: null });

    assert.deepEqual(await sendGiftToErp(gift.id, cpcOnly, user.id), { ok: false, error: "That gift order is not available." }, "another brand's gift cannot be sent");
    const first = await sendGiftToErp(gift.id, both, user.id);
    assert.ok(first.ok && first.url.endsWith(giftReference(gift.id)) && !first.alreadySent);
    assert.equal(received.length, 1);
    const body = received[0].body as { reference: string; brand: string; shipTo: Record<string, string>; lines: { sku: string; quantity: number }[] };
    assert.equal((received[0].body as { key?: string }).key, "erp-test-key", "the key travels in the body (Apps Script cannot read headers)");
    assert.deepEqual([body.reference, body.brand, body.shipTo.line1, body.shipTo.state, body.shipTo.zip, body.shipTo.country, body.lines[0].sku, body.lines[0].quantity], [giftReference(gift.id), "ridhi", "12 Pine St", "OR", "97205", "US", "BR-ERP-01", 1]);
    assert.ok(!first.ok || !first.url.includes("Pine"), "the address never goes in the link");
    const again = await sendGiftToErp(gift.id, both, user.id);
    assert.ok(again.ok && again.alreadySent);
    assert.equal(received.length, 1, "sending again only reopens it: no second order");

    // A wrong key on our side: plain error, nothing recorded as sent.
    const other = await db.giftOrder.create({ data: { campaignCreatorId: (await makeCreator(campaign.id, "erp_lily", { status: "address_collected" })).id, productId: product.id, status: "approved", approvedAt: new Date(), ...sealAddress({ shipName: "Lily Erp", address1: "1 Elm St", address2: null, city: "Austin", state: "TX", postalCode: "78701", country: "US", phone: null }) } });
    process.env.ERP_SECRET = "wrong";
    const refused = await sendGiftToErp(other.id, both, user.id);
    assert.deepEqual(refused, { ok: false, error: "The ERP refused Creator Setu's key. ERP_SECRET must be the same on both sides." });
    assert.equal((await db.giftOrder.findUniqueOrThrow({ where: { id: other.id } })).erpSentAt, null);
    process.env.ERP_SECRET = "erp-test-key";
    const waiting = await db.giftOrder.create({ data: { campaignCreatorId: (await makeCreator(campaign.id, "erp_june", { status: "address_collected" })).id, productId: product.id, status: "needs_approval", ...sealAddress({ shipName: "June", address1: "2 Oak", address2: null, city: "Austin", state: "TX", postalCode: "78701", country: "US", phone: null }) } });
    assert.equal((await sendGiftToErp(waiting.id, both, user.id)).ok, false, "a gift still waiting for approval never goes");

    // The report-back: only with the key, and references map back to the gift.
    assert.equal(erpCallerAllowed(new Request("http://x", { headers: { authorization: "Bearer erp-test-key" } })), true);
    assert.equal(erpCallerAllowed(new Request("http://x", { headers: { authorization: "Bearer nope" } })), false);
    assert.equal(erpCallerAllowed(new Request("http://x")), false);
    assert.equal(await giftIdForReference(giftReference(gift.id)), gift.id);
    assert.equal(await giftIdForReference("CGE-NOTREAL"), null);
    const route = readFileSync("src/app/api/erp/orders/[reference]/route.ts", "utf8");
    assert.ok(route.indexOf("erpCallerAllowed(request)") < route.indexOf("await giftIdForReference("), "the key is checked before anything is read");
    assert.match(route, /applyTracking\(giftId, update, await automationUserId\(\)\)/, "shipped and delivered move the creator on like a tracking file");
    assert.match(readFileSync("src/middleware.ts", "utf8"), /\|api\/erp\|/, "the ERP's server is not sent to the sign-in page");
  } finally {
    process.env.ERP_ORDERS_URL = saved.url;
    process.env.ERP_SECRET = saved.secret;
    server.close();
  }
});

test("Instagram: when Meta refuses to name a post's author, the post still waits in the review queue, and the run says why", async () => {
  const { runDiscovery } = await import("@/lib/discovery");
  await db.hashtag.deleteMany();
  const { user, campaign } = await makeUserAndCampaign("meta-refused", ["block print"]);
  oembedRefuses = true;
  try {
    const summary = await runDiscovery({ campaignId: campaign.id, source: "meta_free", userId: user.id });
    assert.equal(summary.status, "completed");
    assert.equal(summary.added, 0, "nobody can be added without a handle");
    const report = summary.report as { oembed: { calls: number; failed: number; lastError?: string }; pending: unknown[] };
    assert.equal(report.oembed.failed, report.oembed.calls, "every author lookup was refused");
    assert.equal(report.pending.length, report.oembed.calls, "every refused post waits for a reviewer instead of disappearing");
    assert.match(report.oembed.lastError ?? "", /oEmbed Read/);
    assert.match(summary.note ?? "", /Meta refused to name the author for \d+: .*oEmbed Read.*are waiting in the review queue for a handle/);
  } finally {
    oembedRefuses = false;
  }
});

test("Celebrations: hearts once a day at the first open, screen confetti and 'Wohooo!' once a day when every quest is done; never in the way, off with reduced motion", async () => {
  const rachna = readFileSync("src/components/rachna/rachna.tsx", "utf8");
  const css = readFileSync("src/app/globals.css", "utf8");
  const { MILESTONES } = await import("@/lib/rachna");
  assert.match(MILESTONES.dayCleared().text, /^Wohooo! Day cleared/);
  assert.match(rachna, /storageKey\(userId, "hearts"\)[\s\S]{0,120}if \(store\.get\(key\) !== today\)/, "hearts at most once a day per person");
  assert.match(rachna, /storageKey\(userId, `celebrated:\$\{day\}`\)[\s\S]{0,80}if \(store\.get\(key\) !== "1"\)/, "screen confetti at most once a day per person");
  assert.match(rachna, /className="celebrate-confetti pointer-events-none fixed inset-0/, "confetti never blocks a click");
  assert.match(rachna, /className="celebrate-hearts pointer-events-none fixed inset-0/, "hearts never block a click");
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.celebrate-confetti,\s*\.celebrate-hearts \{\s*display: none;/, "nothing moves for someone who asked for reduced motion");
  assert.match(readFileSync("src/components/app-shell.tsx", "utf8"), /<RachnaCelebrations \/>/);
});

test("Instagram: a post that two discovery runs both returned is listed once, and naming or skipping it clears it from every run", async () => {
  const { runDiscovery, pendingPosts, attributePost, dismissPost } = await import("@/lib/discovery");
  await db.hashtag.deleteMany();
  const { user, campaign } = await makeUserAndCampaign("meta-twice", ["block print"]);
  oembedRefuses = true;
  try {
    const first = await runDiscovery({ campaignId: campaign.id, source: "meta_free", userId: user.id });
    const second = await runDiscovery({ campaignId: campaign.id, source: "meta_free", userId: user.id });
    assert.notEqual(first.runId, second.runId);
    const waiting = await pendingPosts(campaign.id);
    assert.equal(new Set(waiting.map((item) => item.post.permalink)).size, waiting.length, "each post is listed once, however many runs returned it");
    assert.ok(waiting.length >= 1);
    assert.ok(waiting.every((item) => item.runId === second.runId), "shown from the newest run");
    const [one, two] = waiting;
    await dismissPost({ runId: one.runId, permalink: one.post.permalink });
    assert.ok(!(await pendingPosts(campaign.id)).some((item) => item.post.permalink === one.post.permalink), "a skipped post does not come back from the older run");
    if (two) {
      await attributePost({ runId: two.runId, permalink: two.post.permalink, handle: "twice_handle", userId: user.id, userName: "Tester" });
      assert.ok(!(await pendingPosts(campaign.id)).some((item) => item.post.permalink === two.post.permalink), "a named post does not come back from the older run");
    }
  } finally {
    oembedRefuses = false;
  }
});

test("Loading screens sit only above list pages: a loading.tsx above a record page would turn another brand's 404 into a 200", () => {
  const dirs = ["src/app/(app)", "src/app/(app)/influencers", "src/app/(app)/campaigns", "src/app/select", "src/app/upload"];
  for (const dir of dirs) assert.equal(existsSync(path.join(dir, "loading.tsx")), false, `${dir}/loading.tsx would wrap pages that answer 404 for another brand's record`);
  for (const dir of ["today", "orders", "content", "reports"]) assert.equal(existsSync(path.join("src/app/(app)", dir, "loading.tsx")), true, `${dir} keeps its loading screen`);
  for (const dir of ["today", "orders", "content", "reports"]) {
    const files = readdirSync(path.join("src/app/(app)", dir), { recursive: true }).map(String).filter((name) => name.endsWith(".tsx") && name !== "loading.tsx");
    for (const name of files) assert.doesNotMatch(readFileSync(path.join("src/app/(app)", dir, name), "utf8"), /notFound\(\)/, `${dir}/${name} must not use notFound() under a loading screen`);
  }
});

test("The legal pages stay public and say we do not delete: Meta's reviewer opens them without signing in, and they must not promise deletion", () => {
  const auth = readFileSync("src/auth.config.ts", "utf8");
  for (const route of ["/privacy", "/terms", "/data-deletion"]) assert.ok(auth.includes(`"${route}"`), `${route} must be reachable without signing in`);
  const deletion = readFileSync("src/app/(legal)/data-deletion/page.tsx", "utf8");
  assert.match(deletion, /do not delete the record/i);
  assert.match(deletion, /do-not-contact/i);
  assert.doesNotMatch(readFileSync("src/app/(legal)/privacy/page.tsx", "utf8"), /Neon/, "the privacy page must name the live database provider, which is Supabase");
});

test("A gift typed in by hand from a creator's message goes through the same rules, encryption and one-gift limit as the link", async () => {
  const { recordSelection, saveGiftChoice } = await import("@/lib/selection-flow");
  const { user, campaign } = await makeUserAndCampaign("hand-entry", ["home decor"]);
  const amazonUrl = "https://www.amazon.com/dp/B0HANDHAND";
  const inStock = await db.product.create({ data: { brandId: "test", sku: "H-IN", title: "Tablecloth", color: "Green", stock: 9, amazonUrl } });
  const otherBrand = await db.product.create({ data: { brandId: "another", sku: "H-OTHER", title: "Napkin", stock: 9, amazonUrl } });
  const load = (id: string) =>
    db.campaignCreator.findUniqueOrThrow({
      where: { id },
      select: { id: true, influencerId: true, status: true, collaborationType: true, approvedFee: true, selectionSentAt: true, campaign: { select: { id: true, brandId: true, giftArticles: true } } },
    });
  const by = { actor: user.id, by: { name: user.name } };

  // Another brand's product is refused, and nothing is written.
  const us = await makeCreatorWithLink(campaign.id, "hand_us", "token-hand-us");
  assert.equal((await saveGiftChoice(await load(us.id), [{ productId: otherBrand.id, quantity: 1 }], usAddress(), by)).ok, false);
  assert.equal(await db.giftOrder.count({ where: { campaignCreatorId: us.id } }), 0);

  // An in-rule US gift is approved, encrypted, credited to the person, and spends the link.
  const ok = await saveGiftChoice(await load(us.id), [{ productId: inStock.id, quantity: 1 }], usAddress(), by);
  assert.equal(ok.ok && ok.approved, true);
  const order = await db.giftOrder.findFirstOrThrow({ where: { campaignCreatorId: us.id } });
  assert.equal(order.status, "approved");
  assert.equal(order.approvedById, user.id);
  assert.ok(order.address1.startsWith("enc:v1:") && order.shipName.startsWith("enc:v1:"), "the address is stored encrypted");
  const now = await readCreator(us.id);
  assert.equal(now.status, "address_collected");
  assert.equal(now.selectionToken, null, "the link is spent, so the creator cannot add a second gift");
  const logged = await db.activity.findFirstOrThrow({ where: { campaignCreatorId: us.id, kind: "status_change" }, orderBy: { createdAt: "desc" } });
  assert.match(logged.body, /entered the gift by hand from the creator's message/);
  assert.equal(logged.automated, false);
  assert.equal(logged.userId, user.id);
  assert.equal((await recordSelection("token-hand-us", inStock.id, usAddress())).ok, false, "the old link no longer works");

  // Outside the rules: a person typing it in IS the approval (Khushi, 19 Nov 2026). It is approved in
  // that person's name, and the rule it breaks is still written down for anyone checking later.
  const abroad = await makeCreatorWithLink(campaign.id, "hand_abroad", "token-hand-abroad");
  const foreign = await saveGiftChoice(await load(abroad.id), [{ productId: inStock.id, quantity: 1 }], usAddress({ country: "Canada" }), by);
  assert.equal(foreign.ok && foreign.approved, true);
  const foreignOrder = await db.giftOrder.findFirstOrThrow({ where: { campaignCreatorId: abroad.id } });
  assert.deepEqual([foreignOrder.status, foreignOrder.approvedById, foreignOrder.approvalNote], ["approved", user.id, null]);
  const foreignNote = await db.activity.findFirstOrThrow({ where: { campaignCreatorId: abroad.id, kind: "note" }, orderBy: { createdAt: "desc" } });
  assert.match(foreignNote.body, new RegExp(`approved by ${user.name} when entering it`));
  assert.match(foreignNote.body, /not in the allowed list/, "the broken rule is still recorded");
  // On the creator's own link, outside the rules still waits for a person (unchanged).
  const linkAbroad = await makeCreatorWithLink(campaign.id, "link_abroad", "token-link-abroad");
  const viaLink = await recordSelection("token-link-abroad", inStock.id, usAddress({ country: "Canada" }));
  assert.equal(viaLink.ok && viaLink.approved, false);
  assert.equal((await db.giftOrder.findFirstOrThrow({ where: { campaignCreatorId: linkAbroad.id } })).status, "needs_approval");

  // A creator with no link yet can still have their gift entered by hand.
  const noLink = await makeCreator(campaign.id, "hand_nolink", { status: "agreed" });
  assert.equal((await saveGiftChoice(await load(noLink.id), [{ productId: inStock.id, quantity: 1 }], usAddress(), by)).ok, true);

  // Two writers for one creator (the creator on the link while a person types the DM in): both read
  // "no gift yet" before either writes. The second is stopped inside the write, so one gift exists.
  const raced = await makeCreatorWithLink(campaign.id, "hand_race", "token-hand-race");
  const seenByBoth = await load(raced.id);
  assert.equal((await saveGiftChoice(seenByBoth, [{ productId: inStock.id, quantity: 1 }], usAddress(), by)).ok, true);
  const second = await saveGiftChoice(seenByBoth, [{ productId: inStock.id, quantity: 1 }], usAddress({ address1: "9 Other Rd" }), { actor: user.id, by: null });
  assert.equal(second.ok, false, "the second writer is refused");
  assert.equal(await db.giftOrder.count({ where: { campaignCreatorId: raced.id } }), 1, "exactly one gift");
  assert.equal(await db.activity.count({ where: { campaignCreatorId: raced.id, kind: "status_change" } }), 1, "and the refused write left nothing behind");

  // The action itself: signed in, brand-scoped, and checked before anything is written.
  const action = readFileSync("src/actions/gift-entry.ts", "utf8");
  const loader = action.slice(action.indexOf("async function loadGiftable"), action.indexOf("export async function productsForGift"));
  assert.ok(loader.indexOf("requireUser()") > 0 && loader.indexOf("allowed(user).creators") > loader.indexOf("requireUser()"), "only a creator in this person's brand");
  for (const check of ["influencer.archived", 'campaign.status === "archived"', "TERMINAL_STATUSES.has", "giftOrders.length > 0", "loadSuppressions"]) assert.ok(loader.includes(check), `refuses when ${check}`);
  const enter = action.slice(action.indexOf("export async function enterGiftByHand"));
  assert.ok(enter.indexOf('field(formData, "confirm") !== "yes"') < enter.indexOf("loadGiftable("), "the person confirms the creator sent the details");
  assert.ok(enter.indexOf("loadGiftable(") < enter.indexOf("saveGiftChoice("), "every check runs before the gift is saved");
  const listing = action.slice(action.indexOf("export async function productsForGift"), action.indexOf("async function loadOpenCampaign"));
  assert.ok(listing.indexOf("loadGiftable(") > 0 && listing.indexOf("loadGiftable(") < listing.indexOf("giftProductsOf("), "products are only listed for a creator this person may gift");
  assert.ok(action.slice(action.indexOf("async function giftProductsOf")).includes("giftableProductsWhere(campaign)"), "and only what the campaign offers");
});

test("Gift a creator from the Gifts page: checks the campaign and the product before writing, finds the creator by handle, then takes the same gift path", () => {
  const action = readFileSync("src/actions/gift-entry.ts", "utf8");
  const fn = action.slice(action.indexOf("export async function giftNewCreator"));
  const at = (text: string) => {
    const index = fn.indexOf(text);
    assert.ok(index > 0, `giftNewCreator uses ${text}`);
    return index;
  };
  // The person confirms, then the campaign must be one of their brand and not archived.
  assert.ok(at('field(formData, "confirm") !== "yes"') < at("loadOpenCampaign("));
  const opener = action.slice(action.indexOf("async function loadOpenCampaign"), action.indexOf("export async function productsForCampaign"));
  assert.ok(opener.includes("requireUser()") && opener.includes("allowed(user).campaigns") && opener.includes('status: { not: "archived" }'), "only an open campaign of this person's brand");
  // The address and the product are checked before any creator row is written.
  assert.ok(at('"Fill in the name and the full shipping address."') < at("db.$transaction("));
  assert.ok(at("giftableProductsWhere(campaign)") < at("db.$transaction("));
  // One creator per handle: an existing profile is reused, never duplicated.
  assert.ok(at("tx.socialProfile.findUnique({ where: { platform_handle: { platform, handle } }") < at("tx.influencer.create("));
  // Then exactly the hand-entry path: every loadGiftable check (do-not-contact, archived, one gift), then saveGiftChoice.
  assert.ok(at("loadGiftable(campaignCreatorId)") < at("saveGiftChoice("));
  const products = action.slice(action.indexOf("export async function productsForCampaign"));
  assert.ok(products.indexOf("loadOpenCampaign(") < products.indexOf("giftProductsOf("), "products are listed only for a campaign this person may gift from");
  // The button sits on the Gifts page and offers only open campaigns of the brands in view.
  const page = readFileSync("src/app/(app)/orders/page.tsx", "utf8");
  assert.ok(page.includes("<GiftCreatorButton") && page.includes('db.campaign.findMany({ where: { ...view.campaigns, status: { not: "archived" } }'));
});

test("US states are always two letters for the ERP and Amazon: names become codes, an unknown state is refused, and older gifts are converted when sent", async () => {
  const { usStateCode, US_STATES } = await import("@/lib/us-states");
  const { saveGiftChoice } = await import("@/lib/selection-flow");
  const { openAddress } = await import("@/lib/address-crypto");
  for (const [raw, code] of [["Florida", "FL"], ["florida", "FL"], ["FL", "FL"], ["fl", "FL"], ["New York", "NY"], ["district of columbia", "DC"], ["Washington DC", "DC"], ["Washington", "WA"]] as const) {
    assert.equal(usStateCode(raw), code, `${raw} -> ${code}`);
  }
  for (const bad of ["Fla.", "Floridaa", "", "Ontario"]) assert.equal(usStateCode(bad), null, `${bad} is not a US state`);
  assert.ok(US_STATES.every(([code]) => /^[A-Z]{2}$/.test(code)), "every code is two capital letters");

  const { user, campaign } = await makeUserAndCampaign("us-states", ["home decor"]);
  const product = await db.product.create({ data: { brandId: "test", sku: "US-STATE-1", title: "Tablecloth", color: "Blue", stock: 5, amazonUrl: "https://www.amazon.com/dp/B0STATESTS" } });
  const load = (id: string) =>
    db.campaignCreator.findUniqueOrThrow({
      where: { id },
      select: { id: true, influencerId: true, status: true, collaborationType: true, approvedFee: true, selectionSentAt: true, campaign: { select: { id: true, brandId: true, giftArticles: true } } },
    });
  const by = { actor: user.id, by: { name: user.name } };

  // Typed as a name, stored as the code.
  const named = await makeCreatorWithLink(campaign.id, "state_named", "token-state-named");
  assert.equal((await saveGiftChoice(await load(named.id), [{ productId: product.id, quantity: 1 }], usAddress({ state: "Florida" }), by)).ok, true);
  const order = await db.giftOrder.findFirstOrThrow({ where: { campaignCreatorId: named.id } });
  assert.equal(openAddress(order).state, "FL");

  // Not a US state: refused, nothing written.
  const wrong = await makeCreatorWithLink(campaign.id, "state_wrong", "token-state-wrong");
  const refused = await saveGiftChoice(await load(wrong.id), [{ productId: product.id, quantity: 1 }], usAddress({ state: "Fla." }), by);
  assert.equal(refused.ok, false);
  assert.equal(await db.giftOrder.count({ where: { campaignCreatorId: wrong.id } }), 0);

  // Outside the US the region stays as typed.
  const abroad = await makeCreatorWithLink(campaign.id, "state_abroad", "token-state-abroad");
  assert.equal((await saveGiftChoice(await load(abroad.id), [{ productId: product.id, quantity: 1 }], usAddress({ country: "Canada", state: "Ontario" }), by)).ok, true);
  assert.equal(openAddress(await db.giftOrder.findFirstOrThrow({ where: { campaignCreatorId: abroad.id } })).state, "Ontario");

  // Gifts saved before this change may hold "Florida": every way out sends the two letters.
  for (const file of ["src/lib/erp.ts", "src/app/(app)/orders/export/route.ts"]) {
    assert.ok(readFileSync(file, "utf8").includes("usStateCode("), `${file} converts the state to its code`);
  }
  // Both forms offer US states as a list of codes.
  for (const file of ["src/components/gift-entry.tsx", "src/app/select/[token]/selection-form.tsx"]) {
    assert.ok(/US_STATES\.map\(\(\[code, name\]\)/.test(readFileSync(file, "utf8")), `${file} lists the US states`);
  }
});

test("The gift forms take an ASIN: it picks from the campaign's own offered products only, and says so when there is no match", () => {
  const action = readFileSync("src/actions/gift-entry.ts", "utf8");
  const listing = action.slice(action.indexOf("async function giftProductsOf"), action.indexOf("export async function productsForGift"));
  assert.ok(listing.includes("giftableProductsWhere(campaign)") && listing.includes("asin: true"), "the ASIN travels with the campaign's offered products");
  const form = readFileSync("src/components/gift-entry.tsx", "utf8");
  // Since 19 Nov the ASIN box is Amazon's "Search by title, SKU or ASIN" under "Add items".
  assert.ok(form.includes('placeholder="Search by title, SKU or ASIN"'), "there is a search box that takes an ASIN");
  assert.ok(/function search\(products: GiftProductOption\[\], text: string\)/.test(form) && form.includes("product.asin"), "the ASIN is looked up in the products already offered, not anywhere else");
  assert.ok(form.includes("Nothing offered in this campaign matches. Check the ASIN or SKU"), "a wrong ASIN is said plainly");
});

test("A gift can hold several products with units, like Amazon's MCF page: every product goes to the ERP and the Amazon file, and a person's entry is approved in their name", async () => {
  const { saveGiftChoice, MAX_UNITS } = await import("@/lib/selection-flow");
  const { user, campaign } = await makeUserAndCampaign("multi-line", ["home decor"]);
  const amazonUrl = "https://www.amazon.com/dp/B0MULTILNE";
  const cloth = await db.product.create({ data: { brandId: "test", sku: "ML-CLOTH", asin: "B0MLCLOTH1", title: "Tablecloth", color: "Sage", stock: 9, amazonUrl, price: 60 } });
  const napkins = await db.product.create({ data: { brandId: "test", sku: "ML-NAP", title: "Napkins", color: "Sage", stock: 9, amazonUrl, price: 25 } });
  const otherBrand = await db.product.create({ data: { brandId: "another", sku: "ML-OTHER", title: "Napkins", stock: 9, amazonUrl } });
  const load = (id: string) =>
    db.campaignCreator.findUniqueOrThrow({
      where: { id },
      select: { id: true, influencerId: true, status: true, collaborationType: true, approvedFee: true, selectionSentAt: true, campaign: { select: { id: true, brandId: true, giftArticles: true } } },
    });
  const by = { actor: user.id, by: { name: user.name } };

  // Refused, nothing written: another brand's product, no product at all, too many units.
  const refused = await makeCreatorWithLink(campaign.id, "ml_refused", "token-ml-refused");
  for (const items of [[{ productId: cloth.id, quantity: 1 }, { productId: otherBrand.id, quantity: 1 }], [], [{ productId: cloth.id, quantity: MAX_UNITS + 1 }], [{ productId: cloth.id, quantity: 0 }], [{ productId: cloth.id, quantity: 1.5 }]]) {
    assert.equal((await saveGiftChoice(await load(refused.id), items, usAddress(), by)).ok, false, JSON.stringify(items));
  }
  assert.equal(await db.giftOrder.count({ where: { campaignCreatorId: refused.id } }), 0);

  // Two products, three napkin sets: one gift, two lines in order, line 1 mirrored on the gift.
  // More than one item breaks the quantity rule, but a person entered it, so it is approved in their name.
  const multi = await makeCreatorWithLink(campaign.id, "ml_multi", "token-ml-multi");
  const saved = await saveGiftChoice(await load(multi.id), [{ productId: cloth.id, quantity: 1 }, { productId: napkins.id, quantity: 2 }, { productId: napkins.id, quantity: 1 }], usAddress(), by);
  assert.equal(saved.ok && saved.approved, true);
  const gift = await db.giftOrder.findFirstOrThrow({ where: { campaignCreatorId: multi.id }, include: { lines: { orderBy: { position: "asc" } } } });
  assert.deepEqual(gift.lines.map((line) => [line.position, line.productId, line.quantity]), [[0, cloth.id, 1], [1, napkins.id, 3]], "the same product twice is one line with the units added up");
  assert.deepEqual([gift.productId, gift.quantity, gift.status, gift.approvedById], [cloth.id, 1, "approved", user.id]);

  // The ERP receives every line.
  const { erpOrderFor } = await import("@/lib/erp");
  const forErp = await db.giftOrder.findUniqueOrThrow({
    where: { id: gift.id },
    select: {
      id: true, status: true, quantity: true, approvedAt: true, approvalNote: true, erpSentAt: true, erpUrl: true, campaignCreatorId: true,
      shipName: true, address1: true, address2: true, city: true, state: true, postalCode: true, country: true, phone: true,
      product: { select: { sku: true, asin: true, title: true, color: true, size: true, price: true } },
      lines: { orderBy: { position: "asc" }, select: { quantity: true, product: { select: { sku: true, asin: true, title: true, color: true, size: true, price: true } } } },
      campaignCreator: { select: { campaign: { select: { name: true, brandId: true } }, influencer: { select: { name: true, email: true, profiles: { where: { platform: "instagram" }, select: { handle: true }, take: 1 } } } } },
    },
  });
  const order = erpOrderFor(forErp as never);
  assert.deepEqual(order.lines.map((line) => [line.sku, line.quantity]), [["ML-CLOTH", 1], ["ML-NAP", 3]]);

  // The Amazon file has one row per product under the same order ID; the one-click order sends every item.
  const route = readFileSync("src/app/(app)/orders/export/route.ts", "utf8");
  assert.ok(route.includes("order.lines.length > 0 ? order.lines : [{ product: order.product, quantity: order.quantity }]") && route.includes("MerchantFulfillmentOrderItemID: `${reference}-${index + 1}`"));
  assert.ok(readFileSync("src/lib/mcf-flow.ts", "utf8").includes("gift.lines.length > 0 ? gift.lines : [{ product: gift.product, quantity: gift.quantity }]"));
});

test("Several-product gifts count in full everywhere, every country leaves as its code, the typed email is checked against do-not-contact, and an unsent gift's address can be edited", async () => {
  const { giftValueUsd, giftItems } = await import("@/lib/gifts");
  const { countryCode } = await import("@/lib/mcf");
  // Value of all products, not just line 1; older single-product gifts unchanged.
  const multi = { quantity: 1, product: { price: 20 }, lines: [{ quantity: 1, product: { price: 20 } }, { quantity: 2, product: { price: 35 } }] };
  assert.equal(giftValueUsd(multi), 90);
  assert.equal(giftValueUsd({ quantity: 3, product: { price: 10 } }), 30);
  assert.equal(giftValueUsd({ quantity: 1, product: { price: null } }), null);
  assert.equal(giftItems(multi).length, 2);
  for (const file of ["src/lib/creator-figures.ts", "src/lib/creator-card-data.ts"]) assert.ok(readFileSync(file, "utf8").includes("giftValueUsd(gift)"), `${file} values the whole gift`);

  // The Country dropdown stores names; the ERP, the Amazon file and one-click orders get the code.
  for (const [name, code] of [["United States", "US"], ["Germany", "DE"], ["Canada", "CA"], ["United Kingdom", "GB"], ["India", "IN"], ["usa", "US"], ["CA", "CA"]] as const) assert.equal(countryCode(name), code, `${name} -> ${code}`);
  assert.equal(countryCode("Atlantis"), null);
  assert.ok(!readFileSync("src/app/(app)/orders/export/route.ts", "utf8").includes("COUNTRY_CODES"), "the Amazon file uses the same country codes as everything else");

  // A typed email (and, for a new creator, the handle) is checked against do-not-contact before anything is written.
  const action = readFileSync("src/actions/gift-entry.ts", "utf8");
  const byHand = action.slice(action.indexOf("export async function enterGiftByHand"), action.indexOf("function itemsFrom"));
  assert.ok(byHand.indexOf("doNotContact(email") > 0 && byHand.indexOf("doNotContact(email") < byHand.indexOf("saveGiftChoice("), "Enter gift by hand checks the typed email first");
  const fromGifts = action.slice(action.indexOf("export async function giftNewCreator"), action.indexOf("export async function enterGiftByHand"));
  assert.ok(fromGifts.indexOf("doNotContact(email, [{ platform, handle }])") > 0 && fromGifts.indexOf("doNotContact(") < fromGifts.indexOf("db.$transaction("), "Gift a creator checks before creating anyone");

  // Edit address: own brand only, never once the gift has left, same address rules, history without the address.
  const edit = action.slice(action.indexOf("export async function editGiftAddress"));
  assert.ok(edit.includes("...allowed(user).gifts"), "only a gift of this person's brand");
  assert.ok(edit.includes("where: { id: gift.id, erpSentAt: null, mcfSentAt: null, status: { in: [...EDITABLE_GIFT_STATUSES] } }"), "written only while unsent, checked in the write itself");
  assert.ok(edit.includes("checkAddress(") && edit.includes("sealAddress("), "same rules, still encrypted");
  assert.ok(edit.includes("erpError: null"), "the ERP's last refusal is cleared so the order can be sent again");
  assert.match(edit, /body: `Shipping address of the gift order edited by \$\{user\.name\}\.`/, "the history names who changed it, never the address");
  const drawer = readFileSync("src/components/gifts-table.tsx", "utf8");
  assert.ok(drawer.includes('(open.status === "needs_approval" || open.status === "approved") && !open.erp.sentAt && !open.amazon.sentAt ? (\n                  <EditAddressButton'), "the button shows only while the gift is unsent");
});
