"use server";

import { revalidatePath } from "next/cache";
import { allowed } from "@/lib/brand-scope";
import { inviteBack, type InviteResult } from "@/lib/invite-back";
import { requireUser } from "@/lib/session";

/** "Invite to campaign" on the Invite back list. Adds the creators as Approved; nothing is sent. */
export async function inviteBackToCampaign(campaignId: string, influencerIds: string[]): Promise<InviteResult> {
  const user = await requireUser();
  const result = await inviteBack({
    campaignId: String(campaignId ?? ""),
    influencerIds: Array.isArray(influencerIds) ? influencerIds.map(String) : [],
    userId: user.id,
    scope: allowed(user),
  });
  if (result.ok) {
    revalidatePath("/influencers/invite-back");
    revalidatePath("/today");
    revalidatePath("/");
    revalidatePath(`/campaigns/${campaignId}`);
  }
  return result;
}
