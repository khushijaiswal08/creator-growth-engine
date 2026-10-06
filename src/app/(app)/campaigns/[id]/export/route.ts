import { allowed } from "@/lib/brand-scope";
import { csvCell, csvResponse, fileSlug } from "@/lib/csv-out";
import { db } from "@/lib/db";
import { GIFT_STATUS_LABELS } from "@/lib/gifts";
import { profileUrl } from "@/lib/profile-url";
import { requireUser } from "@/lib/session";
import { CREATOR_STATUS_LABELS } from "@/lib/status";

const COLUMNS = [
  "name",
  "platform",
  "handle",
  "profile_url",
  "followers",
  "email",
  "location",
  "status",
  "owner",
  "last_contacted",
  "replied",
  "collaboration",
  "next_action",
  "gift",
  "order_number",
  "carrier",
  "tracking_number",
  "shipped",
  "delivered",
  "posts",
  "latest_post",
  "notes",
] as const;

/**
 * The whole campaign as a spreadsheet, one row per profile: the record the
 * team used to keep by hand, now written from what the portal knows.
 * Signed-in users only, and only for a campaign of their brand.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  const campaign = await db.campaign.findFirst({ where: { id, ...allowed(user).campaigns }, select: { name: true } });
  if (!campaign) return new Response("Campaign not found", { status: 404 });

  const creators = await db.campaignCreator.findMany({
    where: { campaignId: id },
    orderBy: { influencer: { name: "asc" } },
    include: {
      influencer: { include: { profiles: { orderBy: { platform: "asc" } } } },
      owner: { select: { name: true } },
      giftOrders: { where: { status: { not: "cancelled" } }, orderBy: { createdAt: "desc" }, take: 1 },
      posts: { orderBy: { postedAt: "desc" }, select: { url: true } },
    },
  });

  const lines = [COLUMNS.join(",")];
  for (const creator of creators) {
    const gift = creator.giftOrders[0] ?? null;
    const profiles = creator.influencer.profiles.length > 0 ? creator.influencer.profiles : [null];
    for (const profile of profiles) {
      const row: Record<(typeof COLUMNS)[number], string | number | boolean | Date | null> = {
        name: creator.influencer.name,
        platform: profile?.platform ?? null,
        handle: profile?.handle ?? null,
        profile_url: profile ? profileUrl(profile.platform, profile.handle) : null,
        followers: profile?.followers ?? null,
        email: creator.influencer.email,
        location: creator.influencer.location,
        status: CREATOR_STATUS_LABELS[creator.status],
        owner: creator.owner?.name ?? null,
        last_contacted: creator.lastContactedAt,
        replied: creator.repliedAt,
        collaboration: creator.collaborationType,
        next_action: creator.nextAction,
        gift: gift ? GIFT_STATUS_LABELS[gift.status] : null,
        order_number: gift?.orderNumber ?? null,
        carrier: gift?.carrier ?? null,
        tracking_number: gift?.trackingNumber ?? null,
        shipped: gift?.shippedAt ?? null,
        delivered: gift?.deliveredAt ?? null,
        posts: creator.posts.length,
        latest_post: creator.posts[0]?.url ?? null,
        notes: creator.influencer.notes,
      };
      lines.push(COLUMNS.map((column) => csvCell(row[column])).join(","));
    }
  }

  return csvResponse(lines, `${fileSlug(campaign.name)}-${new Date().toISOString().slice(0, 10)}.csv`);
}
