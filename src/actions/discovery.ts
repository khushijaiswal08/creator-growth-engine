"use server";

import { revalidatePath } from "next/cache";
import { allowed } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import { DISCOVERY_SOURCES, runDiscovery, type DiscoverySource, type DiscoverySummary } from "@/lib/discovery";
import { requireUser } from "@/lib/session";

export type DiscoveryActionResult = { ok: true; summary: DiscoverySummary } | { ok: false; error: string };

/** Admin only. Runs one discovery for the campaign with the chosen source. */
export async function runDiscoveryAction(campaignId: string, source: string): Promise<DiscoveryActionResult> {
  const user = await requireUser();
  if (user.role !== "admin") return { ok: false, error: "Only an admin can run discovery." };

  if (!DISCOVERY_SOURCES.includes(source as DiscoverySource)) return { ok: false, error: "Unknown discovery source." };

  const campaign = await db.campaign.findFirst({ where: { id: campaignId, ...allowed(user).campaigns }, select: { id: true } });
  if (!campaign) return { ok: false, error: "This campaign no longer exists." };

  const running = await db.discoveryRun.findFirst({
    where: { campaignId, status: "running", startedAt: { gt: new Date(Date.now() - 10 * 60 * 1000) } },
    select: { id: true },
  });
  if (running) return { ok: false, error: "A discovery is already running for this campaign. Wait for it to finish." };

  const summary = await runDiscovery({ campaignId, source: source as DiscoverySource, userId: user.id });

  revalidatePath(`/campaigns/${campaignId}`);
  revalidatePath(`/campaigns/${campaignId}/review`);
  revalidatePath("/influencers");
  return { ok: true, summary };
}
