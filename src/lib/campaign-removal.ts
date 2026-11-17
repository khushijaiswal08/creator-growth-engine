import type { BrandScope } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import { logActivity } from "@/lib/activity";

/**
 * Putting away a campaign nobody needs. Two ways, decided by what it holds:
 *
 *   delete   only a campaign with no creators in it (a test, a mistake): the
 *            campaign and its discovery and scoring run logs go for good.
 *            Nothing else refers to it, so nothing of value is lost.
 *   archive  a campaign with creators: it leaves the Campaigns page and the timers
 *            stop, but every creator, gift, message and note stays, and it can
 *            be restored. Creators are never deleted this way.
 *
 * Both are for admins only and stay inside the person's brand scope.
 */

export type RemovalResult = { ok: true; message: string } | { ok: false; error: string };

type Who = { userId: string; role: string; scope: BrandScope };

const NOT_YOURS: RemovalResult = { ok: false, error: "That campaign is not one you can change." };

export async function deleteEmptyCampaign(campaignId: string, who: Who): Promise<RemovalResult> {
  if (who.role !== "admin") return { ok: false, error: "Only an admin can delete a campaign." };
  const campaign = await db.campaign.findFirst({
    where: { id: campaignId, ...who.scope.campaigns },
    select: { id: true, name: true, _count: { select: { creators: true, discoveryRuns: true, scoringRuns: true } } },
  });
  if (!campaign) return NOT_YOURS;
  const { creators, discoveryRuns, scoringRuns } = campaign._count;
  if (creators > 0) {
    return { ok: false, error: `"${campaign.name}" has ${creators} ${creators === 1 ? "creator" : "creators"} in it, so it cannot be deleted. Archive it instead: their history stays and you can restore it.` };
  }

  try {
    await db.$transaction(async (tx) => {
      // A creator, or a score for one, means the campaign holds real work after all.
      const scored = await tx.fitAssessment.count({ where: { scoringRun: { campaignId: campaign.id } } });
      if (scored > 0) throw new Error("scored");
      await tx.scoringRun.deleteMany({ where: { campaignId: campaign.id } });
      await tx.discoveryRun.deleteMany({ where: { campaignId: campaign.id } });
      // Restrict on CampaignCreator makes this fail, and the whole delete undo, if a creator was added a moment ago.
      await tx.campaign.delete({ where: { id: campaign.id }, select: { id: true } });
      const removed = [discoveryRuns > 0 && `${discoveryRuns} discovery ${discoveryRuns === 1 ? "try" : "tries"}`, scoringRuns > 0 && `${scoringRuns} scoring ${scoringRuns === 1 ? "run" : "runs"}`].filter(Boolean);
      await logActivity(tx, {
        userId: who.userId,
        kind: "campaign_deleted",
        body: `Deleted campaign "${campaign.name}". It had no creators${removed.length > 0 ? `; its ${removed.join(" and ")} went with it` : ""}.`,
      });
    });
  } catch {
    return { ok: false, error: `"${campaign.name}" now holds creators or scores, so it was not deleted. Archive it instead.` };
  }
  return { ok: true, message: `Deleted "${campaign.name}".` };
}

/** Archive (archived: true) or restore (false; it comes back as Paused, so nothing restarts by itself). */
export async function setCampaignArchived(campaignId: string, archived: boolean, who: Who): Promise<RemovalResult> {
  if (who.role !== "admin") return { ok: false, error: "Only an admin can archive a campaign." };
  const campaign = await db.campaign.findFirst({ where: { id: campaignId, ...who.scope.campaigns }, select: { id: true, name: true, status: true } });
  if (!campaign) return NOT_YOURS;
  if ((campaign.status === "archived") === archived) return { ok: true, message: archived ? `"${campaign.name}" is already archived.` : `"${campaign.name}" is not archived.` };

  await db.$transaction(async (tx) => {
    await tx.campaign.update({ where: { id: campaign.id }, data: { status: archived ? "archived" : "paused" }, select: { id: true } });
    await logActivity(tx, {
      userId: who.userId,
      kind: "campaign_archived",
      body: archived ? `Archived campaign "${campaign.name}" (was ${campaign.status}). Its creators and their history are kept.` : `Restored campaign "${campaign.name}" from the archive as Paused.`,
    });
  });
  return { ok: true, message: archived ? `Archived "${campaign.name}". Find it under Archived on the Campaigns page.` : `Restored "${campaign.name}" as Paused.` };
}
