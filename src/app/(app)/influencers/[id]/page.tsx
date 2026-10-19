import type { CreatorStatus } from "@prisma/client";
import { cn } from "cn";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { setInfluencerArchived } from "@/actions/influencers";
import { ActionMenu, MENU_ITEM_CLASS } from "@/components/action-menu";
import { ActivityList } from "@/components/activity-list";
import { Avatar } from "@/components/avatar";
import { EditDetailsButton, LogReplyButton } from "@/components/creator-actions";
import { AddProfileForm, AddToCampaignForm, EditInfluencerForm } from "@/components/influencer-forms";
import { AddPostForm, CopyButton, LogReplyForm } from "@/components/journey-forms";
import { MessageButton, MessageComposer } from "@/components/message-button";
import { ProductPhoto } from "@/components/product-photo";
import { CreatorStatusPill, Pill } from "@/components/status-pill";
import { StatusSelect } from "@/components/status-select";
import { Tabs } from "@/components/tabs";
import { openAddress } from "@/lib/address-crypto";
import { activityOfInfluencer, allowed, viewed } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import { formatCount, formatDay, timeAgo } from "@/lib/format";
import { GIFT_STATUS_LABELS, GIFT_STATUS_TONES } from "@/lib/gifts";
import { deliverySteps, suggestedTemplate } from "@/lib/next-action";
import { displayHandle, PLATFORM_LABELS, profileUrl } from "@/lib/profile-url";
import { appBaseUrl } from "@/lib/selection";
import { requireUser } from "@/lib/session";
import { CREATOR_STATUS_LABELS, SEND_BLOCKED_STATUSES } from "@/lib/status";
import { loadSuppressions } from "@/lib/suppression";
import { describeTrackRecord, trackRecordFor } from "@/lib/track-record";

export const metadata: Metadata = { title: "Creator" };

const ACTIVITY_LIMIT = 100;
const MESSAGE_LIMIT = 60;
const TIMELINE_SHOWN = 8;
const PLATFORM_SHORT = { instagram: "IG", tiktok: "TT", youtube: "YT" } as const;

// The journey as eight marks on one bar. Every status lands on one mark, on "not started", or on a closed outcome.
const STEPS = ["Contacted", "Replied", "Agreed", "Address in", "Shipped", "Delivered", "Content due", "Done"] as const;
const NOT_STARTED: ReadonlySet<CreatorStatus> = new Set(["discovered", "scored", "approved", "review_later"]);

function stepOf(status: CreatorStatus, delivered: boolean): number | "closed" | "not_started" {
  if (NOT_STARTED.has(status)) return "not_started";
  switch (status) {
    case "outreach_scheduled":
    case "contacted":
    case "follow_up_due":
      return 0;
    case "replied":
    case "interested":
    case "negotiating":
      return 1;
    case "agreed":
      return 2;
    case "address_collected":
      return 3;
    case "product_shipped":
      return delivered ? 5 : 4;
    case "content_expected":
      return 6;
    case "content_posted":
    case "completed":
      return 7;
    default:
      return "closed";
  }
}

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
  const now = new Date();

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
          campaign: {
            select: {
              id: true,
              name: true,
              followUpAfterDays: true,
              maxFollowUps: true,
              closeAfterDays: true,
              arrivalCheckDays: true,
              selectionWaitDays: true,
              deliveryWaitDays: true,
              contentReminderDays: true,
              contentDueDays: true,
              noContentAfterDays: true,
            },
          },
          owner: { select: { name: true } },
          giftOrders: {
            where: { status: { not: "cancelled" } },
            orderBy: { createdAt: "desc" },
            include: { product: { select: { title: true, color: true, size: true, sku: true, imageUrl: true, price: true } } },
          },
          posts: { orderBy: { createdAt: "desc" }, select: { id: true, url: true, format: true, postedAt: true, createdAt: true, hasDisclosure: true, mentionsBrand: true, productShown: true } },
        },
      },
    },
  });
  if (!influencer) notFound();

  const [activities, messages, allCampaigns, templates, suppressions, elsewhere] = await Promise.all([
    db.activity.findMany({
      where: activityOfInfluencer(view, id),
      orderBy: { createdAt: "desc" },
      take: ACTIVITY_LIMIT,
      include: {
        user: { select: { name: true } },
        campaignCreator: { select: { campaign: { select: { name: true } } } },
      },
    }),
    db.message.findMany({
      where: { campaignCreator: { influencerId: id, ...view.creators } },
      orderBy: { sentAt: "desc" },
      take: MESSAGE_LIMIT,
      select: {
        id: true,
        campaignCreatorId: true,
        direction: true,
        channel: true,
        body: true,
        sentAt: true,
        user: { select: { name: true } },
        template: { select: { name: true } },
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
  const trackRecord = (await trackRecordFor([id], view)).get(id);
  const record = describeTrackRecord(trackRecord);
  const messageProfiles = influencer.profiles.map(({ id, platform, handle }) => ({ id, platform, handle }));
  const blockedReason = influencer.archived ? "This creator is archived." : suppressed ? `On the do-not-contact list: ${suppressed}` : null;

  const links = influencer.campaigns.map((link) => ({ ...link, giftOrders: link.giftOrders.map((gift) => openAddress(gift)) }));
  const active = links[0] ?? null;
  const gifts = links.flatMap((link) => link.giftOrders.map((gift) => ({ ...gift, campaignName: link.campaign.name })));
  const posts = links.flatMap((link) => link.posts.map((post) => ({ ...post, campaignName: link.campaign.name })));

  const followers = influencer.profiles.reduce<number | null>((best, profile) => (profile.followers !== null && (best === null || profile.followers > best) ? profile.followers : best), null);
  const engagement = influencer.profiles.find((profile) => profile.engagementRate !== null)?.engagementRate ?? null;
  const lastPost = influencer.profiles.reduce<Date | null>((best, profile) => (profile.lastPostAt && (!best || profile.lastPostAt > best) ? profile.lastPostAt : best), null);
  const gmv = influencer.amazonMonthlyGmvUsd === null ? null : Number(influencer.amazonMonthlyGmvUsd);

  const targetFor = (link: (typeof links)[number]) => ({
    campaignCreatorId: link.id,
    influencerName: influencer.name,
    status: link.status,
    profiles: messageProfiles,
    blockedReason: blockedReason ?? (SEND_BLOCKED_STATUSES.has(link.status) ? `Marked ${CREATOR_STATUS_LABELS[link.status]}.` : null),
    purpose: suggestedTemplate(link.status, link.nextAction),
  });

  const timeline = activities.slice(0, TIMELINE_SHOWN);

  return (
    <MessageComposer templates={templates} senderName={user.name}>
      <p className="eyebrow mb-3">
        <Link href="/influencers" className="hover:text-foreground">
          Creators
        </Link>{" "}
        › {influencer.name}
      </p>

      {notice === "exists" ? (
        <p role="status" className="card mb-4 px-4 py-2.5 text-sm">
          That profile was already in the system, so you were taken to the existing creator instead of creating a duplicate.
        </p>
      ) : null}

      {/* Who they are, in one card. */}
      <header className="card mb-5 flex flex-wrap items-start gap-5 p-5">
        <Avatar name={influencer.name} className="size-16 text-[20px]" />
        <div className="grid min-w-0 flex-1 gap-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="mr-1">{influencer.name}</h1>
            {influencer.usSignal !== null && influencer.usSignal >= 80 ? <Pill tone="success">US confirmed</Pill> : influencer.usSignal !== null && influencer.usSignal >= 50 ? <Pill tone="neutral">US likely</Pill> : null}
            {influencer.amazonTier ? <Pill tone="neutral">Amazon: {influencer.amazonTier} tier</Pill> : null}
            {record ? <Pill tone={record.tone}>{record.text}</Pill> : null}
            {influencer.archived ? <Pill tone="neutral">Archived</Pill> : null}
            {suppressed ? <Pill tone="danger">Do not contact: {suppressed}</Pill> : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {influencer.profiles.map((profile) => (
              <a key={profile.id} href={profileUrl(profile.platform, profile.handle)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-semibold text-primary-text hover:underline" title={PLATFORM_LABELS[profile.platform]}>
                <span className="chip px-1.5 py-0 text-[11px]">{PLATFORM_SHORT[profile.platform]}</span>
                {displayHandle(profile.handle)}
              </a>
            ))}
            {influencer.email ? <span className="text-muted-foreground">{influencer.email}</span> : null}
            {influencer.profiles.length === 0 && !influencer.email ? <span className="text-muted-foreground">No contact details yet</span> : null}
          </div>
          <dl className="mt-1 flex flex-wrap gap-x-7 gap-y-2">
            <Stat label="Followers" value={followers === null ? "–" : formatCount(followers)} />
            <Stat label="Engagement" value={engagement === null ? "–" : `${engagement}%`} />
            <Stat label="Location" value={influencer.location ?? "–"} />
            <Stat label="Amazon sales, monthly avg" value={gmv === null ? "–" : `$${Math.round(gmv).toLocaleString("en-US")}`} />
            <Stat label="Last post" value={lastPost ? timeAgo(lastPost, now) : "–"} />
            <Stat label="Content delivered" value={trackRecord && trackRecord.gifts > 0 ? `${trackRecord.delivered} of ${trackRecord.gifts} ${trackRecord.gifts === 1 ? "gift" : "gifts"}` : "–"} />
          </dl>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {active ? <LogReplyButton campaignCreatorId={active.id} campaignName={active.campaign.name} /> : null}
          {active ? <MessageButton target={targetFor(active)} size="default" variant="action" /> : null}
          <ActionMenu>
            {active?.giftOrders[0] ? (
              <Link href="/orders" className={MENU_ITEM_CLASS}>
                Open in Gifts
              </Link>
            ) : null}
            {active ? (
              <Link href={`/campaigns/${active.campaign.id}`} className={MENU_ITEM_CLASS}>
                Open the campaign board
              </Link>
            ) : null}
            {mayArchive ? (
              <form action={setInfluencerArchived.bind(null, influencer.id, !influencer.archived)}>
                <button type="submit" className={MENU_ITEM_CLASS}>
                  {influencer.archived ? "Restore from archive" : "Archive this creator"}
                </button>
              </form>
            ) : (
              <p className="px-3 py-2 text-xs text-muted-foreground">Also works with the other brand, so only an admin can archive.</p>
            )}
          </ActionMenu>
        </div>
      </header>

      <Tabs
        tabs={[
          { key: "overview", label: "Overview" },
          { key: "messages", label: "Messages", count: messages.length },
          { key: "gifts", label: "Gifts", count: gifts.length },
          { key: "content", label: "Content", count: posts.length },
          { key: "history", label: "History", count: activities.length },
          { key: "notes", label: "Notes" },
        ]}
        panels={{
          overview: (
            <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <div className="grid content-start gap-5">
                {links.length === 0 ? (
                  <section className="card p-5">
                    <h2>Journey</h2>
                    <p className="mt-2 text-muted-foreground">
                      {elsewhere > 0 && scope.brandId === null
                        ? "Not in a campaign of the brand you are looking at. Choose the other brand at the top to see their work with this creator."
                        : "Not in any campaign yet."}
                    </p>
                    {openCampaigns.length > 0 ? <AddToCampaignForm influencerId={influencer.id} campaigns={openCampaigns} /> : null}
                  </section>
                ) : null}

                {links.map((link) => {
                  const gift = link.giftOrders[0];
                  const position = stepOf(link.status, Boolean(gift?.deliveredAt));
                  const firstOut = messages.filter((m) => m.campaignCreatorId === link.id && m.direction === "outbound").at(-1)?.sentAt ?? link.lastContactedAt;
                  const firstIn = link.repliedAt ?? messages.filter((m) => m.campaignCreatorId === link.id && m.direction === "inbound").at(-1)?.sentAt ?? null;
                  const moved = (to: string) => activities.filter((a) => a.campaignCreatorId === link.id && a.kind === "status_change" && a.body.includes(` to ${to}`)).at(-1)?.createdAt ?? null;
                  const dates: (Date | null)[] = [
                    firstOut,
                    firstIn,
                    moved("Agreed"),
                    gift?.createdAt ?? moved("Address collected"),
                    gift?.shippedAt ?? null,
                    gift?.deliveredAt ?? null,
                    link.contentDueAt,
                    link.posts[0]?.postedAt ?? link.posts[0]?.createdAt ?? moved("Completed") ?? moved("Content posted"),
                  ];
                  const sequence = link.status === "content_expected" && gift?.deliveredAt ? deliverySteps(gift.deliveredAt, link.campaign) : [];
                  const sentAfter = (from: Date, to: Date | null) => messages.some((m) => m.campaignCreatorId === link.id && m.direction === "outbound" && m.sentAt >= from && (!to || m.sentAt < to));

                  return (
                    <div key={link.id} className="grid gap-5">
                      <section className="card p-5">
                        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
                          <h2>Journey</h2>
                          <Link href={`/campaigns/${link.campaign.id}`} className="chip">
                            {link.campaign.name}
                          </Link>
                          <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
                            {link.owner ? `Owner: ${link.owner.name}` : "No owner yet"}
                            <StatusSelect campaignCreatorId={link.id} status={link.status} label={`Status in ${link.campaign.name}`} />
                          </span>
                        </div>
                        {position === "closed" ? (
                          <p>
                            <Pill tone={link.status === "on_hold" ? "neutral" : "danger"}>{link.status === "on_hold" ? "On hold" : `Closed: ${CREATOR_STATUS_LABELS[link.status]}`}</Pill>
                          </p>
                        ) : (
                          <ol className="grid grid-cols-4 gap-1.5 sm:grid-cols-8 sm:gap-2" aria-label="Journey steps">
                            {STEPS.map((label, index) => {
                              const state = position === "not_started" ? "todo" : index < position ? "done" : index === position ? "current" : "todo";
                              return (
                                <li key={label} className="grid gap-1.5" aria-current={state === "current" ? "step" : undefined}>
                                  <span aria-hidden className={cn("h-1.5 rounded-full", state === "todo" ? "bg-border" : state === "done" ? "bg-success-text" : "bg-primary")} />
                                  <span className={cn("text-[11px] leading-tight font-semibold sm:text-xs", state === "current" ? "text-primary-text" : state === "done" ? "text-foreground" : "text-muted-foreground")}>{label}</span>
                                  <span className="text-[11px] leading-tight text-muted-foreground">{state !== "todo" && dates[index] ? formatDay(dates[index]) : state === "todo" && index === 6 && dates[6] ? `by ${formatDay(dates[6])}` : ""}</span>
                                </li>
                              );
                            })}
                          </ol>
                        )}
                      </section>

                      <section className="card border-[#f1c7d4] bg-[#fffafb] p-5">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                          <div className="min-w-0 flex-1">
                            <p className="label text-primary-text">
                              Next step{link.nextActionDueAt ? ` · ${link.waitingOn === "creator" ? "chase from" : "since"} ${formatDay(link.nextActionDueAt)}` : ""}
                            </p>
                            <p className="mt-0.5 text-[17px] font-bold">{link.nextAction ?? (position === "not_started" ? "Not contacted yet" : "Nothing more to do")}</p>
                            <p className="text-sm text-muted-foreground">
                              {link.lastContactedAt ? `Last message ${formatDay(link.lastContactedAt)}.` : "No message logged yet."}
                              {link.collaborationType ? ` ${link.collaborationType}` : ""}
                              {link.requestedFee !== null ? `, asked $${link.requestedFee}` : ""}
                              {link.approvedFee !== null ? `, approved $${link.approvedFee}` : ""}
                              {link.collaborationType || link.requestedFee !== null ? "." : ""}
                            </p>
                          </div>
                          <MessageButton target={targetFor(link)} size="default" variant="action" label="Open message" />
                        </div>
                        {sequence.length > 0 ? (
                          <ol className="mt-4 grid gap-1 border-t border-[#f1c7d4] pt-3 text-sm">
                            {sequence.map((step, index) => {
                              const reached = now >= step.at;
                              const done = reached && sentAfter(step.at, sequence[index + 1]?.at ?? null);
                              const current = link.nextAction === step.action;
                              return (
                                <li key={step.action} className="grid grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2">
                                  <span aria-hidden className={cn("font-bold", done ? "text-success-text" : current ? "text-primary-text" : "text-muted-foreground")}>{done ? "✓" : current ? "●" : "○"}</span>
                                  <span className={cn(current && "font-semibold")}>{step.action}</span>
                                  <span className={cn("text-xs", current ? "font-semibold text-primary-text" : "text-muted-foreground")}>
                                    {done ? "done" : current ? (now >= step.at ? "due now" : formatDay(step.at)) : reached ? "skipped" : formatDay(step.at)}
                                  </span>
                                </li>
                              );
                            })}
                          </ol>
                        ) : null}
                        {!gift && link.selectionToken ? (
                          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-[#f1c7d4] pt-3 text-sm">
                            <p className="text-muted-foreground">
                              {link.selectionSentAt ? `Selection link sent ${formatDay(link.selectionSentAt)}. Waiting for the creator to choose.` : "The creator has not been sent their selection link yet. The Message button fills it in for you."}
                            </p>
                            <CopyButton text={`${baseUrl}/select/${link.selectionToken}`} label="Copy selection link" />
                          </div>
                        ) : null}
                      </section>
                    </div>
                  );
                })}

                <section className="card p-5">
                  <div className="mb-2 flex items-center justify-between">
                    <h2>Timeline</h2>
                    <a href="#history" className="link text-xs">
                      Full history
                    </a>
                  </div>
                  {timeline.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Nothing logged yet.</p>
                  ) : (
                    <ol>
                      {timeline.map((item) => (
                        <li key={item.id} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-3 border-t py-2.5 first:border-0">
                          <span aria-hidden className={cn("flex size-7 items-center justify-center rounded-full text-[12px] font-bold", item.kind === "message_logged" ? "bg-primary-soft text-primary-text" : item.kind === "status_change" ? "bg-info-soft text-info-text" : "bg-surface-2 text-accent-text")}>
                            {item.kind === "message_logged" ? "✉" : item.kind === "status_change" ? "→" : "•"}
                          </span>
                          <p className="text-sm break-words">
                            <span className="font-semibold">{item.automated ? "Automation" : item.user.name}</span> · {item.body}
                          </p>
                          <span className="text-xs whitespace-nowrap text-muted-foreground">{formatDay(item.createdAt)}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              </div>

              <aside className="grid content-start gap-5">
                {active?.giftOrders[0] ? (
                  <section className="card p-5">
                    <div className="mb-3 flex items-center justify-between">
                      <h2>Current gift</h2>
                      <Pill tone={GIFT_STATUS_TONES[active.giftOrders[0].status]}>{GIFT_STATUS_LABELS[active.giftOrders[0].status]}</Pill>
                    </div>
                    <GiftLine gift={active.giftOrders[0]} />
                  </section>
                ) : active && !active.selectionToken ? (
                  <section className="card p-5">
                    <h2>Gift</h2>
                    <p className="mt-1 text-sm text-muted-foreground">Nothing chosen yet. Once they agree, Message with the product selection template makes their private link.</p>
                  </section>
                ) : null}

                <section className="card p-5">
                  <div className="mb-3 flex items-center justify-between">
                    <h2>About</h2>
                    <EditDetailsButton influencer={{ id: influencer.id, name: influencer.name, email: influencer.email, location: influencer.location, usSignal: influencer.usSignal, notes: influencer.notes }} />
                  </div>
                  <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                    <dt className="text-muted-foreground">Email</dt>
                    <dd className="break-words">{influencer.email ?? "Not known"}</dd>
                    <dt className="text-muted-foreground">Location</dt>
                    <dd>{influencer.location ?? "Not known"}</dd>
                    <dt className="text-muted-foreground">US signal</dt>
                    <dd>{influencer.usSignal ?? "Not assessed"}</dd>
                    {influencer.amazonTier || gmv !== null ? (
                      <>
                        <dt className="text-muted-foreground">Amazon</dt>
                        <dd>
                          {[influencer.amazonTier ? `${influencer.amazonTier} tier` : null, gmv !== null ? `$${Math.round(gmv).toLocaleString("en-US")} avg monthly` : null].filter(Boolean).join(", ")}
                          {influencer.amazonGmvDetail ? <span className="block text-xs text-muted-foreground">{influencer.amazonGmvDetail}</span> : null}
                        </dd>
                      </>
                    ) : null}
                    <dt className="text-muted-foreground">Notes</dt>
                    <dd className="whitespace-pre-line">{influencer.notes ?? <span className="text-muted-foreground">None</span>}</dd>
                  </dl>
                  <details className="disclosure mt-4">
                    <summary>Add another profile</summary>
                    <AddProfileForm influencerId={influencer.id} />
                  </details>
                </section>

                {links.length > 0 ? (
                  <section className="card p-5">
                    <h2 className="mb-3">Past collaborations</h2>
                    <ul className="grid gap-2.5 text-sm">
                      {links.map((link) => (
                        <li key={link.id} className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <Link href={`/campaigns/${link.campaign.id}`} className="font-semibold hover:text-primary-text">
                              {link.campaign.name}
                            </Link>
                            <p className="truncate text-xs text-muted-foreground">
                              {link.giftOrders[0] ? [link.giftOrders[0].product.title, link.giftOrders[0].product.color].filter(Boolean).join(", ") : "No gift yet"}
                              {link.posts.length > 0 ? ` · ${link.posts.length} ${link.posts.length === 1 ? "post" : "posts"}` : ""}
                            </p>
                          </div>
                          <CreatorStatusPill status={link.status} />
                        </li>
                      ))}
                    </ul>
                    {openCampaigns.length > 0 ? (
                      <details className="mt-4">
                        <summary className="inline-flex h-8 cursor-pointer list-none items-center rounded-md border border-border-strong bg-surface px-3 text-[13px] font-semibold hover:bg-surface-2 [&::-webkit-details-marker]:hidden">Add to another campaign</summary>
                        <AddToCampaignForm influencerId={influencer.id} campaigns={openCampaigns} />
                      </details>
                    ) : null}
                  </section>
                ) : null}
              </aside>
            </div>
          ),

          messages: (
            <section className="card overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3">
                <h2>Messages</h2>
                {active ? <MessageButton target={targetFor(active)} size="sm" variant="action" label="New message" /> : null}
              </div>
              {messages.length === 0 ? (
                <p className="px-5 py-10 text-center text-muted-foreground">No messages logged yet. Every message sent with the Message button, and every reply logged, shows here.</p>
              ) : (
                <ol className="grid gap-3 p-5">
                  {messages.map((message) => (
                    <li key={message.id} className={cn("max-w-[85%] rounded-lg border px-4 py-3", message.direction === "outbound" ? "justify-self-end bg-primary-soft/40" : "justify-self-start bg-surface-2/60")}>
                      <p className="mb-1 text-xs text-muted-foreground">
                        {message.direction === "outbound" ? `${message.user.name} sent` : `${influencer.name} replied`}
                        {message.template ? ` · ${message.template.name}` : ""} · {message.channel === "dm" ? "DM" : "Email"} · {formatDay(message.sentAt)} · {message.campaignCreator.campaign.name}
                      </p>
                      <p className="text-sm whitespace-pre-line">{message.body}</p>
                    </li>
                  ))}
                </ol>
              )}
              {active ? (
                <details className="disclosure border-t px-5 py-4">
                  <summary>Log a reply</summary>
                  <div className="pt-3">
                    <LogReplyForm campaignCreatorId={active.id} />
                  </div>
                </details>
              ) : null}
            </section>
          ),

          gifts: (
            <section className="card overflow-hidden">
              <div className="flex items-center justify-between border-b px-5 py-3">
                <h2>Gifts</h2>
                <Link href="/orders" className="link text-xs">
                  Open Gifts
                </Link>
              </div>
              {gifts.length === 0 ? (
                <p className="px-5 py-10 text-center text-muted-foreground">No gift yet.</p>
              ) : (
                <ul className="grid gap-4 p-5">
                  {gifts.map((gift) => (
                    <li key={gift.id} className="grid gap-2">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-xs text-muted-foreground">{gift.campaignName}</span>
                        <Pill tone={GIFT_STATUS_TONES[gift.status]}>{GIFT_STATUS_LABELS[gift.status]}</Pill>
                      </div>
                      <GiftLine gift={gift} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ),

          content: (
            <section className="card overflow-hidden">
              <div className="border-b px-5 py-3">
                <h2>Content</h2>
              </div>
              {posts.length === 0 ? (
                <p className="px-5 pt-6 pb-2 text-center text-muted-foreground">Nothing recorded yet.</p>
              ) : (
                <ul className="grid gap-2 p-5 pb-0">
                  {posts.map((post) => (
                    <li key={post.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                      <a className="link" href={post.url} target="_blank" rel="noopener noreferrer">
                        {post.format ? post.format[0].toUpperCase() + post.format.slice(1) : "Post"}
                      </a>
                      <span className="text-muted-foreground">
                        {post.postedAt ? `posted ${formatDay(post.postedAt)}` : `recorded ${formatDay(post.createdAt)}`} · {post.campaignName}
                      </span>
                      {post.mentionsBrand ? <Pill tone="success">Brand tagged</Pill> : null}
                      {post.productShown ? <Pill tone="success">Product shown</Pill> : null}
                      {post.hasDisclosure ? <Pill tone="success">Disclosure</Pill> : null}
                    </li>
                  ))}
                </ul>
              )}
              {active ? (
                <div className="p-5">
                  <h3 className="mb-3">Record a post</h3>
                  <AddPostForm campaignCreatorId={active.id} />
                </div>
              ) : null}
            </section>
          ),

          history: (
            <section className="card overflow-hidden">
              <div className="flex items-center justify-between border-b px-5 py-3">
                <h2>History</h2>
                <span className="text-xs text-muted-foreground">{activities.length === ACTIVITY_LIMIT ? `Latest ${ACTIVITY_LIMIT}` : `${activities.length} entries`}</span>
              </div>
              <ActivityList items={activities} />
            </section>
          ),

          notes: (
            <section className="card p-5">
              <h2 className="mb-1">Notes and details</h2>
              <p className="text-sm text-muted-foreground">Anything the team should know before the next message: preferred colours, posting days, how they like to be approached.</p>
              <EditInfluencerForm influencer={{ id: influencer.id, name: influencer.name, email: influencer.email, location: influencer.location, usSignal: influencer.usSignal, notes: influencer.notes }} />
            </section>
          ),
        }}
      />
    </MessageComposer>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-[15px] font-bold">{value}</dd>
    </div>
  );
}

function GiftLine({
  gift,
}: {
  gift: {
    id: string;
    status: keyof typeof GIFT_STATUS_LABELS;
    shippedAt: Date | null;
    deliveredAt: Date | null;
    city: string;
    state: string;
    carrier: string | null;
    trackingNumber: string | null;
    approvalNote: string | null;
    product: { title: string; color: string | null; size: string | null; sku: string; imageUrl: string | null; price: { toString(): string } | null };
  };
}) {
  return (
    <div className="flex items-start gap-3">
      <ProductPhoto url={gift.product.imageUrl} size={56} className="size-14 shrink-0 rounded-md" />
      <div className="grid min-w-0 gap-0.5 text-sm">
        <p className="font-semibold">{[gift.product.title, gift.product.color, gift.product.size].filter(Boolean).join(", ")}</p>
        <p className="text-xs text-muted-foreground">
          SKU {gift.product.sku}
          {gift.product.price ? ` · $${gift.product.price.toString()}` : ""}
        </p>
        <p className="text-xs text-muted-foreground">
          {gift.deliveredAt ? `Delivered ${formatDay(gift.deliveredAt)}` : gift.shippedAt ? `Shipped ${formatDay(gift.shippedAt)}` : "Not shipped yet"}
          {[gift.city, gift.state].filter(Boolean).length > 0 ? ` to ${[gift.city, gift.state].filter(Boolean).join(", ")}` : ""}
          {gift.carrier || gift.trackingNumber ? ` · ${[gift.carrier, gift.trackingNumber].filter(Boolean).join(" ")}` : ""}
        </p>
        {gift.approvalNote && gift.status === "needs_approval" ? <p className="text-xs text-warning-text">Needs approval: {gift.approvalNote}</p> : null}
        <Link href="/orders" className="link text-xs">
          Open in Gifts
        </Link>
      </div>
    </div>
  );
}
