import type { ContentStatus, Prisma } from "@prisma/client";
import type { Metadata } from "next";
import Link from "next/link";
import { Avatar } from "@/components/avatar";
import { ContentCard, type ContentCardData } from "@/components/content-card";
import { CreatorName } from "@/components/creator-card";
import { PageHeader } from "@/components/panel";
import { Pill } from "@/components/status-pill";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { viewed } from "@/lib/brand-scope";
import { brandsLabel } from "@/lib/brands";
import { presignView, storageMode } from "@/lib/content-storage";
import { CONTENT_STATUS_LABELS, USAGE_LABELS } from "@/lib/content-upload";
import { db } from "@/lib/db";
import { openCampaignIn } from "@/lib/due";
import { formatDay } from "@/lib/format";
import { describeProduct } from "@/lib/product-list";
import { profileLabel } from "@/lib/profile-url";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Content" };

const POST_LIMIT = 100;
const FILE_LIMIT = 60;

/** Every status that counts as a file in the library (an unfinished upload is not one). */
const LIBRARY_STATUSES = ["received", "approved", "changes_requested"] as const satisfies readonly ContentStatus[];

const FILE_FILTERS = [
  { key: "review", label: "To review", statuses: ["received"] },
  { key: "approved", label: "Approved", statuses: ["approved"] },
  { key: "changes", label: "Changes asked", statuses: ["changes_requested"] },
  { key: "all", label: "All files", statuses: LIBRARY_STATUSES },
] as const satisfies readonly { key: string; label: string; statuses: readonly ContentStatus[] }[];

const megabytes = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1e6).toFixed(1)} MB`);

const FORMAT_LABELS: Record<string, string> = { reel: "Reel", story: "Story", post: "Feed post", carousel: "Carousel", video: "Video", short: "Short", pin: "Pin" };

/**
 * Two tabs: the library of creators' original files (sent through their
 * upload link, each with what the creator allows and the team's decision)
 * and every post recorded, newest first.
 */
export default async function ContentPage({ searchParams }: { searchParams: Promise<{ campaign?: string; tab?: string; files?: string }> }) {
  const user = await requireUser();
  const view = viewed(user);
  const params = await searchParams;

  const campaigns = await db.campaign.findMany({ where: openCampaignIn(view), orderBy: { name: "asc" }, select: { id: true, name: true } });
  const chosen = campaigns.find((campaign) => campaign.id === params.campaign) ?? null;
  const tab = params.tab === "posts" ? "posts" : "files";
  const filter = FILE_FILTERS.find((option) => option.key === params.files) ?? FILE_FILTERS[0];
  const creatorScope: Prisma.CampaignCreatorWhereInput = { ...view.creators, ...(chosen ? { campaignId: chosen.id } : {}) };
  const inScope: Prisma.ContentAssetWhereInput = { archived: false, campaignCreator: creatorScope };
  const postsWhere: Prisma.PostWhereInput = { campaignCreator: creatorScope };
  const link = (next: { tab?: string; files?: string; campaign?: string | null }) => {
    const query = new URLSearchParams();
    const nextTab = next.tab ?? tab;
    if (nextTab === "posts") query.set("tab", "posts");
    const nextFiles = next.files ?? (nextTab === "files" ? filter.key : undefined);
    if (nextTab === "files" && nextFiles && nextFiles !== "review") query.set("files", nextFiles);
    const campaignId = next.campaign === undefined ? chosen?.id : next.campaign;
    if (campaignId) query.set("campaign", campaignId);
    return `/content${query.size ? `?${query}` : ""}`;
  };

  const [fileCounts, assets, posts, total] = await Promise.all([
    db.contentAsset.groupBy({ by: ["status"], where: { ...inScope, status: { not: "uploading" } }, _count: { _all: true } }),
    tab === "files"
      ? db.contentAsset.findMany({
          where: { ...inScope, status: { in: [...filter.statuses] } },
          orderBy: { receivedAt: "desc" },
          take: FILE_LIMIT,
          select: {
            id: true,
            kind: true,
            fileName: true,
            contentType: true,
            sizeBytes: true,
            storageKey: true,
            status: true,
            usageRights: true,
            postUrl: true,
            receivedAt: true,
            creatorNote: true,
            reviewNote: true,
            reviewedBy: { select: { name: true } },
            product: { select: { title: true, color: true, size: true } },
            campaignCreator: { select: { campaign: { select: { name: true } }, influencer: { select: { id: true, name: true } } } },
          },
        })
      : Promise.resolve([]),
    db.post.findMany({
      where: postsWhere,
      orderBy: [{ postedAt: "desc" }, { createdAt: "desc" }],
      take: POST_LIMIT,
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
    db.post.count({ where: postsWhere }),
  ]);
  const countOf = (statuses: readonly ContentStatus[]) => fileCounts.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row._count._all, 0);
  const files = countOf(LIBRARY_STATUSES);

  // Signed addresses are made here, on the server, only for files this person may see; they expire within the hour.
  const cards: ContentCardData[] = await Promise.all(
    assets.map(async (asset) => ({
      id: asset.id,
      kind: asset.kind,
      fileName: asset.fileName,
      sizeLabel: megabytes(asset.sizeBytes),
      status: asset.status as ContentCardData["status"],
      statusLabel: CONTENT_STATUS_LABELS[asset.status],
      usage: asset.usageRights,
      usageLabel: USAGE_LABELS[asset.usageRights],
      viewUrl: await presignView(asset.storageKey, asset.contentType),
      downloadUrl: await presignView(asset.storageKey, asset.contentType, asset.fileName),
      creator: asset.campaignCreator.influencer,
      campaign: asset.campaignCreator.campaign.name,
      product: asset.product ? describeProduct(asset.product) : null,
      postUrl: asset.postUrl,
      receivedLabel: asset.receivedAt ? formatDay(asset.receivedAt) : "",
      creatorNote: asset.creatorNote,
      reviewNote: asset.status === "changes_requested" ? asset.reviewNote : null,
      reviewedBy: asset.reviewedBy?.name ?? null,
    })),
  );

  return (
    <>
      <PageHeader
        title="Content"
        meta={`${brandsLabel(view.brandId, "Both brands")} ·${files} ${files === 1 ? "file" : "files"}, ${countOf(["received"])} to review · ${total} ${total === 1 ? "post" : "posts"}${chosen ? ` in ${chosen.name}` : ""}`}
      />

      <nav aria-label="Content" className="tabs mb-5">
        <Link href={link({ tab: "files", files: "review" })} className="tab" aria-current={tab === "files" ? "true" : undefined}>
          Files <span className="count-pill">{files}</span>
        </Link>
        <Link href={link({ tab: "posts" })} className="tab" aria-current={tab === "posts" ? "true" : undefined}>
          Posts <span className="count-pill">{total}</span>
        </Link>
      </nav>

      {campaigns.length > 1 ? (
        <nav aria-label="Campaign" className="mb-5 flex flex-wrap gap-1.5">
          <Link href={link({ campaign: null })} className="chip" aria-current={chosen === null ? "true" : undefined}>
            All campaigns
          </Link>
          {campaigns.map((campaign) => (
            <Link key={campaign.id} href={link({ campaign: campaign.id })} className="chip" aria-current={chosen?.id === campaign.id ? "true" : undefined}>
              {campaign.name}
            </Link>
          ))}
        </nav>
      ) : null}

      {tab === "files" ? (
        <>
          <nav aria-label="Files" className="mb-5 flex flex-wrap gap-1.5">
            {FILE_FILTERS.map((option) => (
              <Link key={option.key} href={link({ files: option.key })} className="chip" aria-current={filter.key === option.key ? "true" : undefined}>
                {option.label} <span className="tabular-nums opacity-70">{countOf(option.statuses)}</span>
              </Link>
            ))}
          </nav>
          {cards.length === 0 ? (
            <section className="card px-5 py-12 text-center">
              <p className="font-bold text-foreground">{files === 0 ? "No files yet" : `Nothing ${filter.key === "all" ? "here" : filter.label.toLowerCase()}`}</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                {storageMode()
                  ? "Send a creator their upload link with the Message button: the template \u201cSend your files\u201d puts it in. Their videos and photos land here."
                  : "File uploads switch on once the storage keys are added. Until then, creators can reply with a link to their files."}
              </p>
            </section>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
              {cards.map((card) => (
                <ContentCard key={card.id} asset={card} />
              ))}
            </div>
          )}
          {assets.length === FILE_LIMIT ? <p className="mt-4 text-xs text-muted-foreground">Showing the newest {FILE_LIMIT}. Pick a campaign to see older files.</p> : null}
        </>
      ) : (
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
                    {profileLabel(post.socialProfile.platform, post.socialProfile.handle)}
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
      )}
    </>
  );
}
