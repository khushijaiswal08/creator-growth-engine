"use server";

import type { CreatorStatus, Platform, TemplatePurpose } from "@prisma/client";
import { viewed } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import { openCampaignIn } from "@/lib/due";
import { suggestedTemplate } from "@/lib/next-action";
import { requireUser } from "@/lib/session";
import { CREATOR_STATUS_LABELS, SEND_BLOCKED_STATUSES } from "@/lib/status";
import { loadSuppressions } from "@/lib/suppression";

export type CreatorToMessage = {
  campaignCreatorId: string;
  influencerId: string;
  influencerName: string;
  campaignName: string;
  status: CreatorStatus;
  statusLabel: string;
  handle: string | null;
  profiles: { id: string; platform: Platform; handle: string }[];
  blockedReason: string | null;
  purpose: TemplatePurpose | null;
};

const LIMIT = 8;

/** The "New message" picker on Home: creators in the open campaigns the person sees, by name or handle. */
export async function findCreatorsToMessage(rawQuery: string): Promise<CreatorToMessage[]> {
  const user = await requireUser();
  const view = viewed(user);
  const q = rawQuery.trim().replace(/^@/, "").slice(0, 60);
  if (q.length < 2) return [];

  const rows = await db.campaignCreator.findMany({
    where: {
      campaign: openCampaignIn(view),
      influencer: {
        archived: false,
        OR: [{ name: { contains: q, mode: "insensitive" } }, { profiles: { some: { handle: { contains: q.toLowerCase() } } } }],
      },
    },
    orderBy: [{ influencer: { name: "asc" } }, { createdAt: "desc" }],
    take: LIMIT,
    select: {
      id: true,
      status: true,
      nextAction: true,
      campaign: { select: { name: true } },
      influencer: { select: { id: true, name: true, email: true, profiles: { select: { id: true, platform: true, handle: true }, orderBy: { platform: "asc" } } } },
    },
  });
  const suppressions = await loadSuppressions(rows.map((row) => row.influencer));

  return rows.map((row) => {
    const suppressed = suppressions.reasonFor(row.influencer);
    return {
      campaignCreatorId: row.id,
      influencerId: row.influencer.id,
      influencerName: row.influencer.name,
      campaignName: row.campaign.name,
      status: row.status,
      statusLabel: CREATOR_STATUS_LABELS[row.status],
      handle: row.influencer.profiles[0] ? `@${row.influencer.profiles[0].handle}` : null,
      profiles: row.influencer.profiles,
      blockedReason: suppressed ? `On the do-not-contact list: ${suppressed}` : SEND_BLOCKED_STATUSES.has(row.status) ? `Marked ${CREATOR_STATUS_LABELS[row.status]}.` : null,
      purpose: suggestedTemplate(row.status, row.nextAction),
    };
  });
}
