import type { Metadata } from "next";
import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { PageHeader } from "@/components/panel";
import { CampaignStatusPill, Pill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { viewed } from "@/lib/brand-scope";
import { brandName } from "@/lib/brands";
import { db } from "@/lib/db";
import { formatDay } from "@/lib/format";
import { GIFT_STATUS_LABELS, GIFT_STATUS_TONES } from "@/lib/gifts";
import { displayHandle } from "@/lib/profile-url";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Search" };

const LIMIT = 20;

/** One search box for everything the person may see: creators, campaigns and gift orders. */
export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const view = viewed(user);
  const q = ((await searchParams).q ?? "").trim().slice(0, 100);
  const contains = { contains: q, mode: "insensitive" as const };

  const [influencers, campaigns, orders] = q
    ? await Promise.all([
        db.influencer.findMany({
          where: {
            ...view.influencers,
            archived: false,
            OR: [{ name: contains }, { email: contains }, { location: contains }, { profiles: { some: { handle: { contains: q.toLowerCase().replace(/^@/, "") } } } }],
          },
          orderBy: { name: "asc" },
          take: LIMIT,
          select: { id: true, name: true, location: true, profiles: { select: { platform: true, handle: true, followers: true }, orderBy: { platform: "asc" } } },
        }),
        db.campaign.findMany({
          where: { ...view.campaigns, name: contains },
          orderBy: { updatedAt: "desc" },
          take: LIMIT,
          select: { id: true, name: true, brandId: true, status: true, _count: { select: { creators: true } } },
        }),
        db.giftOrder.findMany({
          where: {
            ...view.gifts,
            OR: [{ orderNumber: contains }, { trackingNumber: contains }, { product: { sku: contains } }, { campaignCreator: { influencer: { name: contains } } }],
          },
          orderBy: { createdAt: "desc" },
          take: LIMIT,
          select: {
            id: true,
            status: true,
            createdAt: true,
            orderNumber: true,
            trackingNumber: true,
            product: { select: { sku: true, title: true, color: true } },
            campaignCreator: { select: { influencer: { select: { id: true, name: true } }, campaign: { select: { name: true } } } },
          },
        }),
      ])
    : [[], [], []];

  const total = influencers.length + campaigns.length + orders.length;

  return (
    <>
      <PageHeader title="Search" meta={q ? `${total === 0 ? "Nothing" : total} found for "${q}"` : "Creators, campaigns and gift orders."} />

      <form action="/search" method="get" role="search" className="mb-8 flex max-w-xl gap-2">
        <Input type="search" name="q" defaultValue={q} placeholder="Name, handle, email, campaign, SKU, tracking number" autoFocus aria-label="Search" />
        <Button type="submit" variant="action">
          Search
        </Button>
      </form>

      {q && total === 0 ? <p className="text-muted-foreground">Nothing matched. Try a shorter word, or paste a profile link on the Home page to add someone new.</p> : null}

      {influencers.length > 0 ? (
        <section className="card mb-6 overflow-hidden">
          <h2 className="border-b px-4 py-3">Creators</h2>
          <ul>
            {influencers.map((person) => {
              const profile = person.profiles[0];
              return (
                <li key={person.id} className="flex items-center gap-3 border-b px-4 py-2.5 last:border-0 hover:bg-surface-2/50">
                  <Avatar name={person.name} />
                  <div className="min-w-0 flex-1">
                    <Link href={`/influencers/${person.id}`} className="font-semibold hover:text-primary-text">
                      {person.name}
                    </Link>
                    <p className="truncate text-xs text-muted-foreground">
                      {profile ? displayHandle(profile.handle) : "No profile"}
                      {profile?.followers ? ` · ${Intl.NumberFormat("en", { notation: "compact" }).format(profile.followers)}` : ""}
                      {person.location ? ` · ${person.location}` : ""}
                    </p>
                  </div>
                  <Button asChild size="sm" variant="outline">
                    <Link href={`/influencers/${person.id}`}>Open</Link>
                  </Button>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {campaigns.length > 0 ? (
        <section className="card mb-6 overflow-hidden">
          <h2 className="border-b px-4 py-3">Campaigns</h2>
          <ul>
            {campaigns.map((campaign) => (
              <li key={campaign.id} className="flex items-center gap-3 border-b px-4 py-2.5 last:border-0 hover:bg-surface-2/50">
                <div className="min-w-0 flex-1">
                  <Link href={`/campaigns/${campaign.id}`} className="font-semibold hover:text-primary-text">
                    {campaign.name}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {brandName(campaign.brandId)} · {campaign._count.creators} creators
                  </p>
                </div>
                <CampaignStatusPill status={campaign.status} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {orders.length > 0 ? (
        <section className="card overflow-hidden">
          <h2 className="border-b px-4 py-3">Gift orders</h2>
          <ul>
            {orders.map((order) => (
              <li key={order.id} className="flex items-center gap-3 border-b px-4 py-2.5 last:border-0 hover:bg-surface-2/50">
                <div className="min-w-0 flex-1">
                  <Link href={`/influencers/${order.campaignCreator.influencer.id}`} className="font-semibold hover:text-primary-text">
                    {order.campaignCreator.influencer.name}
                  </Link>
                  <p className="truncate text-xs text-muted-foreground">
                    {order.product.title}
                    {order.product.color ? `, ${order.product.color}` : ""} · {order.product.sku} · {order.campaignCreator.campaign.name} · {formatDay(order.createdAt)}
                    {order.orderNumber ? ` · ${order.orderNumber}` : ""}
                  </p>
                </div>
                <Pill tone={GIFT_STATUS_TONES[order.status]}>{GIFT_STATUS_LABELS[order.status]}</Pill>
                <Button asChild size="sm" variant="outline">
                  <Link href="/orders">Gifts</Link>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
