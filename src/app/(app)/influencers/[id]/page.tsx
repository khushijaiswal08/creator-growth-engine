import { cn } from "cn";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { setInfluencerArchived } from "@/actions/influencers";
import { ActivityList } from "@/components/activity-list";
import { openAddress } from "@/lib/address-crypto";
import { AddProfileForm, AddToCampaignForm, EditInfluencerForm } from "@/components/influencer-forms";
import { AddPostForm, CopyButton, LogReplyForm } from "@/components/journey-forms";
import { MessageButton, MessageComposer } from "@/components/message-button";
import { Panel } from "@/components/panel";
import { ProductPhoto } from "@/components/product-photo";
import { Pill } from "@/components/status-pill";
import { StatusSelect } from "@/components/status-select";
import { Button } from "@/components/ui/button";
import { activityOfInfluencer, allowed, viewed } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import { formatCount, formatDay } from "@/lib/format";
import { GIFT_STATUS_LABELS, GIFT_STATUS_TONES } from "@/lib/gifts";
import { JOURNEY_STEPS, journeyPosition } from "@/lib/journey-steps";
import { displayHandle, PLATFORM_LABELS, profileUrl } from "@/lib/profile-url";
import { appBaseUrl } from "@/lib/selection";
import { requireUser } from "@/lib/session";
import { CREATOR_STATUS_LABELS, SEND_BLOCKED_STATUSES } from "@/lib/status";
import { loadSuppressions } from "@/lib/suppression";
import { describeTrackRecord, trackRecordFor } from "@/lib/track-record";

export const metadata: Metadata = { title: "Creator" };

const ACTIVITY_LIMIT = 100;
const HISTORY_SHOWN = 6;

export default async function InfluencerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ notice?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { notice } = await searchParams;

  // Whether this person may open the creator at all is decided by their own brand. What the page
  // then shows (campaigns, journeys, activity) follows the brand they are looking at, so the other
  // brand's work with the same creator never appears on a one-brand screen.
  const scope = allowed(user);
  const view = viewed(user);
  const influencer = await db.influencer.findFirst({
    where: { id, ...scope.influencers },
    include: {
      profiles: { orderBy: { platform: "asc" } },
      campaigns: {
        where: view.creators,
        orderBy: { createdAt: "desc" },
        include: {
          campaign: { select: { id: true, name: true } },
          owner: { select: { name: true } },
          giftOrders: {
            where: { status: { not: "cancelled" } },
            orderBy: { createdAt: "desc" },
            take: 1,
            include: { product: { select: { title: true, color: true, size: true, sku: true, imageUrl: true } } },
          },
          posts: { orderBy: { createdAt: "desc" }, select: { id: true, url: true, format: true, postedAt: true } },
        },
      },
    },
  });
  if (!influencer) notFound();

  const [activities, allCampaigns, templates, suppressions, elsewhere] = await Promise.all([
    db.activity.findMany({
      where: activityOfInfluencer(view, id),
      orderBy: { createdAt: "desc" },
      take: ACTIVITY_LIMIT,
      include: {
        user: { select: { name: true } },
        campaignCreator: { select: { campaign: { select: { name: true } } } },
      },
    }),
    db.campaign.findMany({
      where: { ...view.campaigns, status: { not: "archived" } },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    db.template.findMany({
      where: { archived: false },
      orderBy: { name: "asc" },
      select: { id: true, name: true, purpose: true, body: true },
    }),
    loadSuppressions([influencer]),
    // Campaigns of the brand not on screen. Only the number is used, never their details.
    view.brandId ? db.campaignCreator.count({ where: { influencerId: id, NOT: view.creators } }) : 0,
  ]);
  // Archiving hides a creator from everyone, so someone tied to one brand cannot do it to a shared creator.
  const mayArchive = scope.brandId === null || elsewhere === 0;

  const joined = new Set(influencer.campaigns.map((link) => link.campaignId));
  const openCampaigns = allCampaigns.filter((campaign) => !joined.has(campaign.id));
  const baseUrl = await appBaseUrl();
  const suppressed = suppressions.reasonFor(influencer);
  // Did they post last time? The one thing to know before gifting again.
  const record = describeTrackRecord((await trackRecordFor([id], view)).get(id));
  const messageProfiles = influencer.profiles.map(({ id, platform, handle }) => ({ id, platform, handle }));
  const blockedReason = influencer.archived
    ? "This creator is archived."
    : suppressed
      ? `On the do-not-contact list: ${suppressed}`
      : null;
  const recent = activities.slice(0, HISTORY_SHOWN);
  const older = activities.slice(HISTORY_SHOWN);

  return (
    <>
      <header className="mb-8 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <h1>{influencer.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
            {influencer.profiles.map((profile) => (
              <a
                key={profile.id}
                href={profileUrl(profile.platform, profile.handle)}
                target="_blank"
                rel="noopener noreferrer"
                className="link"
                title={PLATFORM_LABELS[profile.platform]}
              >
                {displayHandle(profile.handle)}
                {profile.followers !== null ? (
                  <span className="ml-1 font-normal text-muted-foreground tabular-nums">{formatCount(profile.followers)}</span>
                ) : null}
              </a>
            ))}
            {influencer.location ? <span className="text-muted-foreground">{influencer.location}</span> : null}
            {influencer.email ? <span className="text-muted-foreground">{influencer.email}</span> : null}
            {influencer.profiles.length === 0 && !influencer.location && !influencer.email ? (
              <span className="text-muted-foreground">No contact details yet</span>
            ) : null}
            {influencer.archived ? <Pill tone="neutral">Archived</Pill> : null}
            {suppressed ? <Pill tone="danger">Do not contact: {suppressed}</Pill> : null}
            {record ? <Pill tone={record.tone}>{record.text}</Pill> : null}
          </div>
        </div>
        {mayArchive ? (
          <form action={setInfluencerArchived.bind(null, influencer.id, !influencer.archived)}>
            <Button type="submit" variant="ghost" size="sm">
              {influencer.archived ? "Restore from archive" : "Archive"}
            </Button>
          </form>
        ) : (
          <span className="max-w-56 text-right text-xs text-muted-foreground">Also works with the other brand, so only an admin can archive.</span>
        )}
      </header>

      {notice === "exists" ? (
        <p role="status" className="card mb-6 px-4 py-2.5">
          That profile was already in the system, so you were taken to the existing creator instead of creating a duplicate.
        </p>
      ) : null}

      <div className="grid gap-x-12 gap-y-10 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <MessageComposer templates={templates} senderName={user.name}>
          <div className="grid content-start gap-10">
            {influencer.campaigns.length === 0 ? (
              <Panel plain title="Journey">
                <p className="pt-3 text-muted-foreground">
                  {elsewhere > 0 && scope.brandId === null
                    ? "Not in a campaign of the brand you are looking at. Choose the other brand in the sidebar to see their work with this creator."
                    : "Not in any campaign yet."}
                </p>
                {openCampaigns.length > 0 ? <AddToCampaignForm influencerId={influencer.id} campaigns={openCampaigns} /> : null}
              </Panel>
            ) : null}

            {influencer.campaigns.map((link) => {
              const gift = link.giftOrders[0] ? openAddress(link.giftOrders[0]) : undefined;
              const position = journeyPosition(link.status);
              const current = position.kind === "step" ? position.index : -1;
              return (
                <section key={link.id}>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-2.5">
                    <h2>
                      Journey
                      <Link href={`/campaigns/${link.campaign.id}`} className="ml-2 font-sans text-sm font-normal text-muted-foreground hover:text-foreground">
                        {link.campaign.name}
                      </Link>
                    </h2>
                    <StatusSelect campaignCreatorId={link.id} status={link.status} label={`Status in ${link.campaign.name}`} />
                  </div>

                  {/* The five steps as the team thinks of them. A closed journey says so instead. */}
                  {position.kind === "closed" ? (
                    <p className="mt-4">
                      <Pill tone={position.paused ? "neutral" : "danger"}>{position.paused ? "On hold" : `Closed: ${position.label}`}</Pill>
                    </p>
                  ) : (
                    <ol className="mt-5 grid grid-cols-5 gap-2" aria-label="Journey steps">
                      {JOURNEY_STEPS.map((step, index) => {
                        const state = index < current ? "done" : index === current ? "current" : "todo";
                        return (
                          <li key={step.label} className="grid gap-2" aria-current={state === "current" ? "step" : undefined}>
                            <span
                              aria-hidden
                              className={cn("h-1 rounded-full", state === "todo" ? "bg-border" : state === "done" ? "bg-foreground" : "bg-primary")}
                            />
                            <span className={cn("text-xs", state === "current" ? "font-medium text-primary-text" : state === "done" ? "text-foreground" : "text-muted-foreground")}>
                              {step.label}
                            </span>
                          </li>
                        );
                      })}
                    </ol>
                  )}

                  <div className="card mt-5 grid gap-3 p-4">
                    <div>
                      <p className="eyebrow">Next step</p>
                      <p className="mt-0.5 text-[15px] font-medium">
                        {link.nextAction ?? (position.kind === "not_started" ? "Not contacted yet" : "Nothing more to do")}
                        {link.nextActionDueAt ? (
                          <span className="font-normal text-muted-foreground">
                            {" "}
                            ({link.waitingOn === "creator" ? "chase from" : "since"} {formatDay(link.nextActionDueAt)})
                          </span>
                        ) : null}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {link.owner ? `${link.owner.name} looks after this.` : "Nobody assigned yet."}
                        {link.lastContactedAt ? ` Last message ${formatDay(link.lastContactedAt)}.` : ""}
                        {link.collaborationType ? ` ${link.collaborationType}` : ""}
                        {link.requestedFee !== null ? `, asked $${link.requestedFee}` : ""}
                        {link.approvedFee !== null ? `, approved $${link.approvedFee}` : ""}
                        {link.collaborationType || link.requestedFee !== null ? "." : ""}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <MessageButton
                        target={{
                          campaignCreatorId: link.id,
                          influencerName: influencer.name,
                          status: link.status,
                          profiles: messageProfiles,
                          blockedReason: blockedReason ?? (SEND_BLOCKED_STATUSES.has(link.status) ? `Marked ${CREATOR_STATUS_LABELS[link.status]}.` : null),
                        }}
                      />
                      <details className="disclosure" open={link.status === "contacted" || link.status === "follow_up_due" || link.status === "replied"}>
                        <summary>Log a reply</summary>
                        <div className="pt-3">
                          <LogReplyForm campaignCreatorId={link.id} />
                        </div>
                      </details>
                    </div>
                  </div>

                  {/* The gift: what was chosen, where it is. */}
                  <div className="mt-5 flex items-start gap-4">
                    {gift ? <ProductPhoto url={gift.product.imageUrl} size={56} className="size-14 shrink-0 rounded-md" /> : null}
                    <div className="min-w-0 grid gap-1">
                      <p className="eyebrow">Gift</p>
                      {gift ? (
                        <>
                          <p>
                            {[gift.product.title, gift.product.color, gift.product.size].filter(Boolean).join(", ")}{" "}
                            <span className="text-muted-foreground">(SKU {gift.product.sku})</span>
                          </p>
                          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                            <Pill tone={GIFT_STATUS_TONES[gift.status]}>{GIFT_STATUS_LABELS[gift.status]}</Pill>
                            {gift.deliveredAt ? `Delivered ${formatDay(gift.deliveredAt)}` : gift.shippedAt ? `Shipped ${formatDay(gift.shippedAt)}` : null}
                            {[gift.city, gift.state].filter(Boolean).length > 0
                              ? `To ${[gift.city, gift.state].filter(Boolean).join(", ")}`
                              : "Address not recorded"}
                            <Link href="/orders" className="link">
                              Open in Gift orders
                            </Link>
                          </p>
                          {gift.approvalNote && gift.status === "needs_approval" ? (
                            <p className="text-sm text-warning-text">Needs approval: {gift.approvalNote}</p>
                          ) : null}
                        </>
                      ) : link.selectionToken ? (
                        <div className="flex flex-wrap items-center gap-3">
                          <p className="text-muted-foreground">
                            {link.selectionSentAt
                              ? `Link sent ${formatDay(link.selectionSentAt)}. Waiting for the creator to choose.`
                              : "The creator has not been sent their link yet. The Message button fills it in for you."}
                          </p>
                          <CopyButton text={`${baseUrl}/select/${link.selectionToken}`} label="Copy selection link" />
                        </div>
                      ) : (
                        <p className="text-muted-foreground">
                          Nothing chosen yet. Click Message and pick the product selection template: the creator&apos;s private link is made
                          and filled in for you.
                        </p>
                      )}
                    </div>
                  </div>

                  <details className="disclosure mt-5" open={link.status === "content_expected" || link.status === "content_posted"}>
                    <summary>Content{link.posts.length > 0 ? ` (${link.posts.length} recorded)` : ""}</summary>
                    <div className="grid gap-3 pt-3">
                      {link.posts.length > 0 ? (
                        <ul className="grid gap-1">
                          {link.posts.map((post) => (
                            <li key={post.id}>
                              <a className="link" href={post.url} target="_blank" rel="noopener noreferrer">
                                {post.format ?? "Post"}
                              </a>
                              <span className="text-muted-foreground"> recorded {formatDay(post.postedAt)}</span>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <AddPostForm campaignCreatorId={link.id} />
                    </div>
                  </details>
                </section>
              );
            })}

            {influencer.campaigns.length > 0 && openCampaigns.length > 0 ? (
              <details className="disclosure">
                <summary>Add to another campaign</summary>
                <AddToCampaignForm influencerId={influencer.id} campaigns={openCampaigns} />
              </details>
            ) : null}
          </div>
        </MessageComposer>

        <aside className="grid content-start gap-10">
          <Panel plain title="About">
            <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 pt-3 text-sm">
              <dt className="text-muted-foreground">Email</dt>
              <dd className="break-words">{influencer.email ?? "Not known"}</dd>
              <dt className="text-muted-foreground">Location</dt>
              <dd>{influencer.location ?? "Not known"}</dd>
              <dt className="text-muted-foreground">US signal</dt>
              <dd>{influencer.usSignal ?? "Not assessed"}</dd>
              <dt className="text-muted-foreground">Notes</dt>
              <dd className="whitespace-pre-line">{influencer.notes ?? <span className="text-muted-foreground">None</span>}</dd>
            </dl>
            <div className="mt-4 grid gap-2">
              <details className="disclosure">
                <summary>Edit details</summary>
                <EditInfluencerForm
                  influencer={{
                    id: influencer.id,
                    name: influencer.name,
                    email: influencer.email,
                    location: influencer.location,
                    usSignal: influencer.usSignal,
                    notes: influencer.notes,
                  }}
                />
              </details>
              <details className="disclosure">
                <summary>Add another profile</summary>
                <AddProfileForm influencerId={influencer.id} />
              </details>
            </div>
          </Panel>

          <Panel
            plain
            title="History"
            aside={<span className="text-xs text-muted-foreground">{activities.length === ACTIVITY_LIMIT ? `Latest ${ACTIVITY_LIMIT}` : `${activities.length}`}</span>}
          >
            <ActivityList items={recent} className="[&>li]:px-0" />
            {older.length > 0 ? (
              <details className="disclosure mt-3">
                <summary>Show {older.length} older</summary>
                <ActivityList items={older} className="mt-2 border-t [&>li]:px-0" />
              </details>
            ) : null}
          </Panel>
        </aside>
      </div>
    </>
  );
}
