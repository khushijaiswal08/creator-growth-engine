"use client";

import { cn } from "cn";
import { ExternalLink, IdCard } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { getCreatorCard } from "@/actions/creator-card";
import { Avatar } from "@/components/avatar";
import { MessageButton } from "@/components/message-button";
import { ProfileLinks } from "@/components/profile-links";
import { Cloud, RachnaPortrait } from "@/components/rachna/rachna";
import { CreatorStatusPill, Pill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WarmthChip } from "@/components/warmth-chip";
import type { CardPost, CreatorCard } from "@/lib/creator-card-data";
import { formatCount, formatDay } from "@/lib/format";
import { isWarmth } from "@/lib/reply-reader";

/*
 * The creator card: tap a creator's name anywhere and their whole history
 * with us opens in one place, with Rachna's verdict on top. Gifts and their
 * value, posts and their reach, clicks and sales, the affiliate quote, the
 * Amazon Creator Connections figures, two small charts, and the timeline.
 * Every number is something the portal recorded; the card invents nothing.
 */

const money = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;

/** A creator's name that opens their card. Middle-click or Ctrl-click still opens the profile page. */
export function CreatorName({ id, name, className, children }: { id: string; name: string; className?: string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <a
        href={`/influencers/${id}`}
        className={cn(className, "group/name inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1 align-bottom")}
        title="Open the creator card"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          setOpen(true);
        }}
      >
        <span className="truncate">{children ?? name}</span>
        {/* The little card: the cue that a tap opens their history. */}
        <IdCard aria-hidden className="size-3.5 shrink-0 text-primary/70 group-hover/name:text-primary" strokeWidth={2} />
      </a>
      {open ? <CreatorCardDialog id={id} name={name} open={open} onOpenChange={setOpen} /> : null}
    </>
  );
}

export function CreatorCardDialog({ id, name, open, onOpenChange }: { id: string; name: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [card, setCard] = useState<CreatorCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    startTransition(async () => {
      try {
        const data = await getCreatorCard(id);
        if (!data) setError("This creator is outside your brand, or was removed.");
        else setCard(data);
      } catch {
        setError("The card could not be loaded just now.");
      }
    });
  }, [id, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto p-0 sm:max-w-3xl" onClick={(event) => event.stopPropagation()}>
        <DialogHeader className="sr-only">
          <DialogTitle>{name}</DialogTitle>
          <DialogDescription>The creator&apos;s history with us and Rachna&apos;s verdict.</DialogDescription>
        </DialogHeader>
        {card ? (
          <CardBody card={card} />
        ) : (
          <div className="flex items-center gap-4 p-6">
            <RachnaPortrait pose={error ? "think" : "idle"} size={56} lively={!error} />
            <p className="text-sm text-muted-foreground">{error ?? `Reading ${name.split(" ")[0]}'s history...`}</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CardBody({ card }: { card: CreatorCard }) {
  const { influencer, stats, verdict, figures, campaigns, months, message } = card;
  const latestWarmth = campaigns.map((link) => link.replyWarmth).find(isWarmth) ?? null;
  const fee = campaigns.map((link) => link.approvedFee ?? link.requestedFee).find((value): value is number => value !== null) ?? null;
  const collab = campaigns.map((link) => link.collaborationType).find((value) => value !== null) ?? null;
  const posts = campaigns.flatMap((link) => link.posts).sort((a, b) => a.at.getTime() - b.at.getTime());
  const hasNumbers = posts.some((post) => post.views !== null || post.clicks !== null || post.salesUsd !== null);

  return (
    <div className="grid gap-5 p-6">
      {/* Who */}
      <div className="flex flex-wrap items-start gap-4">
        <Avatar name={influencer.name} className="size-14 text-lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[20px]">{influencer.name}</h2>
            <Pill tone={verdict.tone}>{verdict.label}</Pill>
            {latestWarmth ? <WarmthChip warmth={latestWarmth} /> : null}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {[influencer.location, stats.followers ? `${formatCount(stats.followers)} followers` : null, influencer.amazonTier ? `Amazon ${influencer.amazonTier}` : null, `with us since ${formatDay(influencer.createdAt)}`].filter(Boolean).join(" · ")}
          </p>
          <div className="mt-2">
            <ProfileLinks profiles={card.profiles} />
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {message ? <MessageButton size="sm" variant="action" label="Message" target={message} /> : null}
          <Button asChild size="sm" variant="outline">
            <Link href={`/influencers/${influencer.id}`}>Open profile</Link>
          </Button>
        </div>
      </div>

      {/* Rachna's verdict */}
      <div className="rachna-home flex items-start gap-3">
        <RachnaPortrait pose={verdict.pose} size={56} lively />
        <div className="min-w-0 flex-1">
          <Cloud tail="left">
            <p className="label mb-0.5">Rachna says</p>
            <p className="text-sm">{verdict.text}</p>
          </Cloud>
        </div>
      </div>

      {/* The figures */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Tile label="Gifts given" value={String(stats.gifts)} note={stats.giftValueUsd > 0 ? `${money(stats.giftValueUsd)} in products` : stats.gifts > 0 ? "value not on file" : "none yet"} />
        <Tile
          label="Content delivered"
          value={String(figures.content)}
          note={
            figures.content > stats.posts
              ? `${stats.posts === 0 ? "no" : stats.posts} post ${stats.posts === 1 ? "link" : "links"} on file${figures.contentRate !== null ? `, ${figures.contentRate}% delivered` : ""}`
              : figures.contentRate !== null
                ? `${figures.contentRate}% of collaborations delivered`
                : stats.pending > 0
                  ? `${stats.pending} in progress`
                  : "none yet"
          }
        />
        <Tile label="Reach" value={stats.reach > 0 ? formatCount(stats.reach) : "–"} note={figures.reachPerPost !== null ? `about ${formatCount(figures.reachPerPost)} a post${figures.reachMultiple !== null ? `, ${figures.reachMultiple}× followers` : ""}` : "no views logged yet"} />
        <Tile label="Engagement" value={figures.engagementRate !== null ? `${figures.engagementRate}%` : "–"} note={stats.engagements > 0 ? `${formatCount(stats.engagements)} likes, comments and shares` : "no likes logged yet"} />
        <Tile label="Clicks to Amazon" value={stats.clicks > 0 ? formatCount(stats.clicks) : "–"} note={stats.clicks > 0 ? "from their posts" : "none logged yet"} />
        <Tile label="Sales from their content" value={stats.salesUsd > 0 ? money(stats.salesUsd) : "–"} note={stats.salesUsd > 0 && stats.giftValueUsd > 0 ? `${(stats.salesUsd / stats.giftValueUsd).toFixed(1)}× the gift value` : "none logged yet"} />
      </div>

      {/* Terms */}
      <div className="grid gap-2 rounded-xl border bg-surface-2/50 p-4 text-sm sm:grid-cols-3">
        <div>
          <p className="label">Affiliate quote</p>
          <p className="mt-0.5">{influencer.affiliateQuote ?? <span className="text-muted-foreground">Not on file. Add it under Edit on the profile.</span>}</p>
        </div>
        <div>
          <p className="label">Fee asked</p>
          <p className="mt-0.5">{fee !== null ? money(fee) : <span className="text-muted-foreground">None, gifted only</span>}</p>
        </div>
        <div>
          <p className="label">Collaboration</p>
          <p className="mt-0.5">{collab ? <span className="capitalize">{collab}</span> : <span className="text-muted-foreground">Not agreed yet</span>}</p>
        </div>
      </div>

      {/* Amazon */}
      {influencer.amazonTier ? (
        <div className="rounded-xl border border-[#f3d9a4] bg-warning-soft/40 p-4 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-semibold">Amazon Creator Connections · {influencer.amazonTier}</p>
            {influencer.amazonMonthlyGmvUsd !== null ? <p className="text-muted-foreground">{money(influencer.amazonMonthlyGmvUsd)} a month in Amazon sales overall</p> : null}
          </div>
          <p className="mt-1 text-muted-foreground">
            For our products: {stats.clicks > 0 ? `${formatCount(stats.clicks)} clicks` : "no clicks logged"}, {stats.salesUsd > 0 ? `${money(stats.salesUsd)} in sales` : "no sales logged"}. Attributed figures join by themselves once the Amazon reports are imported.
          </p>
          {influencer.amazonGmvDetail ? <p className="mt-1 text-xs text-muted-foreground">{influencer.amazonGmvDetail}</p> : null}
        </div>
      ) : null}

      {/* Charts */}
      <div className="grid gap-4 md:grid-cols-2">
        <section className="card p-4">
          <h3 className="mb-1">Reach per post</h3>
          {hasNumbers ? (
            <Bars data={posts.map((post) => ({ label: formatDay(post.at), value: post.views ?? 0, hint: `${post.format ?? "post"} · ${post.views !== null ? `${post.views.toLocaleString("en-US")} views` : "no views logged"}${post.salesUsd ? ` · ${money(post.salesUsd)}` : ""}` }))} color="var(--primary)" />
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">No numbers yet. Log views, clicks and sales on each post from the profile&apos;s Content tab.</p>
          )}
        </section>
        <section className="card p-4">
          <h3 className="mb-1">Last six months</h3>
          <MonthBars months={months} />
        </section>
      </div>

      {/* Timeline */}
      <section className="card overflow-hidden">
        <div className="border-b px-4 py-2.5">
          <h3>History with us</h3>
        </div>
        {campaigns.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">Not in any campaign you can see.</p>
        ) : (
          <ul className="divide-y">
            {campaigns.map((link) => (
              <li key={link.id} className="grid gap-2 px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/campaigns/${link.campaignId}`} className="font-semibold hover:text-primary-text">
                    {link.name}
                  </Link>
                  <CreatorStatusPill status={link.status} />
                  {link.fitScore !== null ? <span className="text-xs text-muted-foreground">fit {link.fitScore}</span> : null}
                  {link.replyRead ? <span className="text-xs text-muted-foreground">· Rachna: {link.replyRead}</span> : null}
                </div>
                {link.gifts.length > 0 || link.posts.length > 0 ? (
                  <ul className="grid gap-1 text-[13px]">
                    {link.gifts.map((gift) => (
                      <li key={gift.id} className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                        <span aria-hidden className="size-1.5 rounded-full bg-[#d97706]" />
                        <span className="text-foreground">Gift</span>
                        <span>
                          {gift.quantity > 1 ? `${gift.quantity} × ` : ""}
                          {gift.product}
                          {gift.priceUsd !== null ? ` (${money(gift.priceUsd * gift.quantity)})` : ""}
                        </span>
                        <span>· {gift.delivered ? "delivered" : gift.status.replace(/_/g, " ")}</span>
                        <span>· {formatDay(gift.at)}</span>
                      </li>
                    ))}
                    {link.posts.map((post) => (
                      <li key={post.id} className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                        <span aria-hidden className="size-1.5 rounded-full bg-[#16a34a]" />
                        <a href={post.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-foreground hover:text-primary-text">
                          {post.format ? post.format[0].toUpperCase() + post.format.slice(1) : "Post"}
                          <ExternalLink className="size-3" />
                        </a>
                        <span>· {formatDay(post.at)}</span>
                        <PostNumbers post={post} />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function PostNumbers({ post }: { post: CardPost }) {
  const parts = [
    post.views !== null ? `${formatCount(post.views)} views` : null,
    post.likes !== null ? `${formatCount(post.likes)} likes` : null,
    post.comments !== null ? `${formatCount(post.comments)} comments` : null,
    post.clicks !== null ? `${formatCount(post.clicks)} clicks` : null,
    post.salesUsd !== null ? `${money(post.salesUsd)} sales` : null,
  ].filter(Boolean);
  if (parts.length === 0) return <span>· no numbers yet</span>;
  return <span>· {parts.join(", ")}</span>;
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="card grid content-start gap-1 p-3.5">
      <p className="label">{label}</p>
      <p className="stat-number text-[24px]">{value}</p>
      <p className="text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

/** Plain bars, one per post, tallest to the biggest number. SVG, no library. */
function Bars({ data, color }: { data: { label: string; value: number; hint: string }[]; color: string }) {
  const width = 320;
  const height = 120;
  const pad = 4;
  const max = Math.max(1, ...data.map((point) => point.value));
  const slot = (width - pad * 2) / Math.max(1, data.length);
  const bar = Math.max(6, Math.min(28, slot * 0.6));
  return (
    <svg viewBox={`0 0 ${width} ${height + 18}`} className="h-auto w-full" role="img" aria-label="Reach per post">
      {data.map((point, index) => {
        const h = Math.max(2, Math.round((point.value / max) * height));
        const x = pad + index * slot + (slot - bar) / 2;
        return (
          <g key={index}>
            <title>{`${point.label}: ${point.hint}`}</title>
            <rect x={x} y={height - h} width={bar} height={h} rx={3} fill={color} opacity={point.value === 0 ? 0.25 : 0.9} />
            {data.length <= 8 ? (
              <text x={x + bar / 2} y={height + 13} textAnchor="middle" fontSize="9" fill="#6b7280">
                {point.label.replace(/,.*$/, "")}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/** Gifts and posts a month, with sales as a line of dots when there are any. */
function MonthBars({ months }: { months: CreatorCard["months"] }) {
  const width = 320;
  const height = 120;
  const pad = 4;
  const max = Math.max(1, ...months.map((point) => Math.max(point.gifts, point.posts)));
  const maxSales = Math.max(0, ...months.map((point) => point.salesUsd));
  const slot = (width - pad * 2) / months.length;
  const bar = Math.min(18, slot * 0.3);
  const nothing = months.every((point) => point.gifts === 0 && point.posts === 0);
  if (nothing) return <p className="py-6 text-center text-sm text-muted-foreground">Nothing in the last six months.</p>;
  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height + 18}`} className="h-auto w-full" role="img" aria-label="Gifts and posts by month">
        {months.map((point, index) => {
          const x = pad + index * slot + slot / 2;
          const giftH = Math.round((point.gifts / max) * height);
          const postH = Math.round((point.posts / max) * height);
          return (
            <g key={point.month}>
              <title>{`${point.label}: ${point.gifts} gifts, ${point.posts} posts${point.reach ? `, ${point.reach.toLocaleString("en-US")} views` : ""}${point.salesUsd ? `, ${money(point.salesUsd)} sales` : ""}`}</title>
              <rect x={x - bar - 1} y={height - giftH} width={bar} height={giftH} rx={3} fill="#d97706" opacity={0.85} />
              <rect x={x + 1} y={height - postH} width={bar} height={postH} rx={3} fill="#16a34a" opacity={0.85} />
              {maxSales > 0 && point.salesUsd > 0 ? <circle cx={x} cy={height - Math.round((point.salesUsd / maxSales) * (height - 10)) - 5} r={4} fill="var(--primary)" /> : null}
              <text x={x} y={height + 13} textAnchor="middle" fontSize="9" fill="#6b7280">
                {point.label}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="mt-1 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
        <span>
          <span aria-hidden className="mr-1 inline-block size-2 rounded-sm bg-[#d97706]" />
          gifts
        </span>
        <span>
          <span aria-hidden className="mr-1 inline-block size-2 rounded-sm bg-[#16a34a]" />
          posts
        </span>
        {maxSales > 0 ? (
          <span>
            <span aria-hidden className="mr-1 inline-block size-2 rounded-full bg-primary" />
            sales
          </span>
        ) : null}
      </p>
    </div>
  );
}
