import type { Metadata } from "next";
import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { CreatorName } from "@/components/creator-card";
import { PageHeader } from "@/components/panel";
import { Pill } from "@/components/status-pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { viewed } from "@/lib/brand-scope";
import { brandName } from "@/lib/brands";
import { db } from "@/lib/db";
import { formatDay } from "@/lib/format";
import { displayHandle, PLATFORM_LABELS } from "@/lib/profile-url";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Content" };

const LIMIT = 100;

const FORMAT_LABELS: Record<string, string> = { reel: "Reel", story: "Story", post: "Feed post", carousel: "Carousel", video: "Video", short: "Short", pin: "Pin" };

/** Every post creators delivered, newest first. The library of the files themselves arrives in Phase C. */
export default async function ContentPage({ searchParams }: { searchParams: Promise<{ campaign?: string }> }) {
  const user = await requireUser();
  const view = viewed(user);
  const params = await searchParams;

  const campaigns = await db.campaign.findMany({ where: { ...view.campaigns, status: { not: "archived" } }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  const chosen = campaigns.find((campaign) => campaign.id === params.campaign) ?? null;

  const [posts, total] = await Promise.all([
    db.post.findMany({
      where: { campaignCreator: { ...view.creators, ...(chosen ? { campaignId: chosen.id } : {}) } },
      orderBy: [{ postedAt: "desc" }, { createdAt: "desc" }],
      take: LIMIT,
      select: {
        id: true,
        url: true,
        format: true,
        postedAt: true,
        createdAt: true,
        hasDisclosure: true,
        mentionsBrand: true,
        productShown: true,
        collabInvite: true,
        socialProfile: { select: { platform: true, handle: true } },
        campaignCreator: { select: { campaign: { select: { id: true, name: true } }, influencer: { select: { id: true, name: true } } } },
      },
    }),
    db.post.count({ where: { campaignCreator: { ...view.creators, ...(chosen ? { campaignId: chosen.id } : {}) } } }),
  ]);

  return (
    <>
      <PageHeader title="Content" meta={`${view.brandId ? brandName(view.brandId) : "Both brands"} · ${total} ${total === 1 ? "post" : "posts"} recorded${chosen ? ` in ${chosen.name}` : ""}`} />

      {campaigns.length > 1 ? (
        <nav aria-label="Campaign" className="mb-5 flex flex-wrap gap-1.5">
          <Link href="/content" className="chip" aria-current={chosen === null ? "true" : undefined}>
            All campaigns
          </Link>
          {campaigns.map((campaign) => (
            <Link key={campaign.id} href={`/content?campaign=${campaign.id}`} className="chip" aria-current={chosen?.id === campaign.id ? "true" : undefined}>
              {campaign.name}
            </Link>
          ))}
        </nav>
      ) : null}

      <section className="card overflow-hidden">
        {posts.length === 0 ? (
          <p className="px-4 py-12 text-center text-muted-foreground">No posts recorded yet. Record a creator&apos;s post from their page under Content.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Creator</TableHead>
                <TableHead>Campaign</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Where</TableHead>
                <TableHead>Posted</TableHead>
                <TableHead>Checks</TableHead>
                <TableHead className="text-right">Link</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {posts.map((post) => (
                <TableRow key={post.id}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={post.campaignCreator.influencer.name} className="size-7 text-[11px]" />
                      <CreatorName id={post.campaignCreator.influencer.id} name={post.campaignCreator.influencer.name} className="font-semibold hover:text-primary-text" />
                    </div>
                  </TableCell>
                  <TableCell>
                    <Link href={`/campaigns/${post.campaignCreator.campaign.id}`} className="hover:text-primary-text">
                      {post.campaignCreator.campaign.name}
                    </Link>
                  </TableCell>
                  <TableCell>{post.format ? (FORMAT_LABELS[post.format] ?? post.format) : "Post"}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {PLATFORM_LABELS[post.socialProfile.platform]} {displayHandle(post.socialProfile.handle)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{formatDay(post.postedAt ?? post.createdAt)}</TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-1">
                      {post.mentionsBrand ? <Pill tone="success">Brand tagged</Pill> : null}
                      {post.productShown ? <Pill tone="success">Product shown</Pill> : null}
                      {post.hasDisclosure ? <Pill tone="success">Disclosure</Pill> : null}
                      {post.collabInvite ? <Pill tone="info">Collab invite</Pill> : null}
                      {!post.mentionsBrand && !post.productShown && !post.hasDisclosure && !post.collabInvite ? <span className="text-xs text-muted-foreground">none ticked</span> : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <a href={post.url} target="_blank" rel="noopener noreferrer" className="link">
                      Open
                    </a>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
      <p className="mt-4 text-xs text-muted-foreground">Creators&apos; own uploads arrive with the content library. For now each row links to the live post.</p>
    </>
  );
}
