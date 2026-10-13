"use server";

import { revalidatePath } from "next/cache";
import { allowed } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import {
  attributePost,
  discoverySlice,
  DISCOVERY_SOURCES,
  dismissPost,
  startDiscovery,
  type AttributeOutcome,
  type DiscoverySource,
  type DiscoverySummary,
} from "@/lib/discovery";
import { requireUser } from "@/lib/session";

export type DiscoveryActionResult = { ok: true; summary: DiscoverySummary } | { ok: false; error: string };

/** Admin only. Starts a discovery for the campaign and does its first slice. */
export async function startDiscoveryAction(campaignId: string, source: string): Promise<DiscoveryActionResult> {
  const user = await requireUser();
  if (user.role !== "admin") return { ok: false, error: "Only an admin can run discovery." };
  if (!DISCOVERY_SOURCES.includes(source as DiscoverySource)) return { ok: false, error: "Unknown discovery source." };

  const campaign = await db.campaign.findFirst({ where: { id: campaignId, ...allowed(user).campaigns }, select: { id: true } });
  if (!campaign) return { ok: false, error: "This campaign no longer exists." };

  const running = await db.discoveryRun.findFirst({
    where: { campaignId, status: "running", startedAt: { gt: new Date(Date.now() - 30 * 60 * 1000) } },
    select: { id: true },
  });
  if (running) return { ok: false, error: "A discovery is already running for this campaign. Wait for it to finish." };

  const summary = await startDiscovery({ campaignId, source: source as DiscoverySource, userId: user.id });
  revalidateCampaign(campaignId);
  return { ok: true, summary };
}

/** Continues a running discovery by one slice, for the screen that started it. */
export async function continueDiscoveryAction(runId: string): Promise<DiscoveryActionResult> {
  const user = await requireUser();
  if (user.role !== "admin") return { ok: false, error: "Only an admin can run discovery." };
  const run = await db.discoveryRun.findFirst({ where: { id: runId, campaign: allowed(user).campaigns }, select: { campaignId: true } });
  if (!run) return { ok: false, error: "That discovery run does not exist." };

  const summary = await discoverySlice(runId);
  if (summary.done) revalidateCampaign(run.campaignId);
  return { ok: true, summary };
}

/** A reviewer names the account behind an Instagram post Meta would not attribute. */
export async function attributePostAction(runId: string, permalink: string, handle: string): Promise<AttributeOutcome> {
  const user = await requireUser();
  const run = await db.discoveryRun.findFirst({ where: { id: runId, campaign: allowed(user).campaigns }, select: { campaignId: true } });
  if (!run) return { ok: false, error: "That discovery run does not exist." };
  const result = await attributePost({ runId, permalink, handle, userId: user.id, userName: user.name });
  if (result.ok) revalidateCampaign(run.campaignId);
  return result;
}

export async function dismissPostAction(runId: string, permalink: string): Promise<{ ok: boolean }> {
  const user = await requireUser();
  const run = await db.discoveryRun.findFirst({ where: { id: runId, campaign: allowed(user).campaigns }, select: { campaignId: true } });
  if (!run) return { ok: false };
  const ok = await dismissPost({ runId, permalink });
  if (ok) revalidatePath(`/campaigns/${run.campaignId}/review`);
  return { ok };
}

function revalidateCampaign(campaignId: string) {
  revalidatePath(`/campaigns/${campaignId}`);
  revalidatePath(`/campaigns/${campaignId}/review`);
  revalidatePath("/influencers");
}
