"use client";

import { cn } from "cn";
import { AtSign, Check, Clapperboard, Clock, DollarSign, ExternalLink, Eye, Gift, Heart, IdCard, MessageCircle, MousePointerClick, Sparkles, Star, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { getCreatorCard } from "@/actions/creator-card";
import { Avatar } from "@/components/avatar";
import { MessageButton, useOpenComposer } from "@/components/message-button";
import { RachnaPortrait } from "@/components/rachna/rachna";
import { CreatorStatusPill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WarmthChip } from "@/components/warmth-chip";
import type { Grade } from "@/lib/creator-card";
import type { CardPost, CreatorCard } from "@/lib/creator-card-data";
import { formatCount, formatDay } from "@/lib/format";
import { profileUrl } from "@/lib/profile-url";
import { isWarmth } from "@/lib/reply-reader";
import { TONE_CLASSES, type StatusTone } from "@/lib/status";

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
      <DialogContent showCloseButton={!card} className="max-h-[92vh] gap-0 overflow-hidden rounded-3xl p-0 shadow-[0_30px_80px_rgba(15,23,42,0.35)] sm:max-w-[780px]" onClick={(event) => event.stopPropagation()}>
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

// Rachna's verdict strip takes the grade's colour: green for the good ones, amber to watch, red to skip.
const VERDICT_STYLE: Record<StatusTone, { box: string; text: string }> = {
  success: { box: "border-[#c9f0d8] bg-gradient-to-r from-[#ecfdf3] to-[#f6fef9]", text: "text-[#14532d]" },
  primary: { box: "border-[#f3cdd9] bg-gradient-to-r from-primary-faint to-surface", text: "text-foreground" },
  warning: { box: "border-[#fde3b0] bg-gradient-to-r from-warning-soft to-surface", text: "text-[#78350f]" },
  danger: { box: "border-[#fecdd6] bg-gradient-to-r from-danger-soft to-surface", text: "text-[#881337]" },
  info: { box: "border-[#cddcff] bg-gradient-to-r from-info-soft to-surface", text: "text-[#1e3a8a]" },
  violet: { box: "border-[#ddd6fe] bg-gradient-to-r from-violet-soft to-surface", text: "text-[#4c1d95]" },
  neutral: { box: "border-border bg-gradient-to-r from-surface-2 to-surface", text: "text-foreground" },
};

const GRADE_ICON: Record<Grade, React.ReactNode> = {
  star: <Star className="size-3.5" strokeWidth={2.4} />,
  good: <Check className="size-3.5" strokeWidth={2.8} />,
  mixed: <TriangleAlert className="size-3.5" strokeWidth={2.4} />,
  waiting: <Clock className="size-3.5" strokeWidth={2.4} />,
  risky: <TriangleAlert className="size-3.5" strokeWidth={2.4} />,
  new: <Sparkles className="size-3.5" strokeWidth={2.4} />,
};

type CardTab = "overview" | "history" | "numbers";

function CardBody({ card }: { card: CreatorCard }) {
  const { influencer, stats, verdict, figures, campaigns, months, message } = card;
  const [tab, setTab] = useState<CardTab>("overview");
  // Pages without the message composer (Creators, Ranking) get no Message button rather than a dead one.
  const canMessage = useOpenComposer() !== null;
  const latestWarmth = campaigns.map((link) => link.replyWarmth).find(isWarmth) ?? null;
  const fee = campaigns.map((link) => link.approvedFee ?? link.requestedFee).find((value): value is number => value !== null) ?? null;
  const collab = campaigns.map((link) => link.collaborationType).find((value) => value !== null) ?? null;
  const posts = campaigns.flatMap((link) => link.posts).sort((a, b) => a.at.getTime() - b.at.getTime());
  const hasNumbers = posts.some((post) => post.views !== null || post.clicks !== null || post.salesUsd !== null);
  const profile = card.profiles[0] ?? null;
  const style = VERDICT_STYLE[verdict.tone];
  // "Solid creator. 1 collaboration from 1 gift." -> the first sentence in bold.
  const split = verdict.text.indexOf(". ");
  const lead = split > 0 ? verdict.text.slice(0, split + 1) : verdict.text;
  const rest = split > 0 ? verdict.text.slice(split + 2) : "";

  return (
    <div className="flex max-h-[92vh] flex-col max-sm:max-h-none">
      {/* Who */}
      <div className="flex flex-wrap items-start gap-4 bg-gradient-to-b from-[#fff7fa] to-surface px-6 pt-6 pb-4 sm:flex-nowrap">
        <Avatar name={influencer.name} className="size-16 text-xl" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-[24px] font-extrabold tracking-[-0.02em]">{influencer.name}</h2>
            <span className={cn("inline-flex h-6 items-center gap-1 rounded-full px-2.5 text-xs font-extrabold", TONE_CLASSES[verdict.tone])}>
              {GRADE_ICON[verdict.grade]}
              {verdict.label}
            </span>
            {latestWarmth ? <WarmthChip warmth={latestWarmth} /> : null}
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] font-semibold text-muted-foreground">
            {profile ? (
              <a href={profileUrl(profile.platform, profile.handle)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-bold text-primary hover:underline">
                <PlatformIcon platform={profile.platform} />@{profile.handle}
              </a>
            ) : null}
            {stats.followers ? <span>· {formatCount(stats.followers)} followers</span> : null}
            {influencer.location ? <span>· {influencer.location}</span> : null}
            {card.profiles.length > 1 ? <span className="text-faint">· +{card.profiles.length - 1} more</span> : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {message && canMessage ? <MessageButton size="sm" variant="action" label="Message" icon={<MessageCircle className="size-[15px]" strokeWidth={2.3} />} target={message} /> : null}
          <Button asChild size="sm" variant="outline">
            <Link href={`/influencers/${influencer.id}`}>Open profile</Link>
          </Button>
          <DialogClose asChild>
            <Button size="icon-sm" variant="outline" aria-label="Close">
              <X className="size-[17px]" strokeWidth={2.2} />
            </Button>
          </DialogClose>
        </div>
      </div>

      {/* Rachna's verdict */}
      <div className={cn("mx-6 flex items-center gap-3.5 rounded-2xl border px-4 py-3.5", style.box)}>
        <RachnaPortrait pose={verdict.pose} size={46} />
        <p className={cn("text-[14.5px] leading-snug font-semibold", style.text)}>
          <b className="font-extrabold">{lead}</b>
          {rest ? ` ${rest}` : ""}
        </p>
      </div>

      <nav aria-label="Card sections" className="tabs mt-4 px-[14px]">
        {(["overview", "history", "numbers"] as const).map((key) => (
          <button key={key} type="button" className="tab capitalize" aria-current={tab === key ? "page" : undefined} onClick={() => setTab(key)}>
            {key}
            {key === "history" ? <span className="count-pill">{campaigns.length}</span> : null}
          </button>
        ))}
      </nav>

      <div className="grid gap-[18px] overflow-y-auto px-6 pt-5 pb-6">
        {tab === "overview" ? (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatTile icon={<Gift className="size-3.5" strokeWidth={2.3} />} label="Gifts given" value={String(stats.gifts)} note={stats.giftValueUsd > 0 ? `${money(stats.giftValueUsd)} in products` : stats.gifts > 0 ? "value not on file" : "none yet"} />
              <StatTile
                icon={<Clapperboard className="size-3.5" strokeWidth={2.3} />}
                label="Content"
                value={String(figures.content)}
                note={
                  figures.content > stats.posts
                    ? `${stats.posts === 0 ? "no" : stats.posts} post ${stats.posts === 1 ? "link" : "links"} on file`
                    : figures.contentRate !== null
                      ? `${figures.contentRate}% delivered`
                      : stats.pending > 0
                        ? `${stats.pending} in progress`
                        : "none yet"
                }
              />
              <StatTile
                icon={<DollarSign className="size-3.5" strokeWidth={2.3} />}
                label="Sales"
                value={stats.salesUsd > 0 ? money(stats.salesUsd) : "–"}
                note={stats.salesUsd > 0 && stats.giftValueUsd > 0 ? `${(stats.salesUsd / stats.giftValueUsd).toFixed(1)}× the gift value` : stats.salesUsd > 0 ? "from their content" : "none logged yet"}
                good={stats.salesUsd > 0}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <MiniStat icon={<Eye className="size-[18px] text-info-text" strokeWidth={2.2} />} value={stats.reach > 0 ? formatCount(stats.reach) : "–"} label={figures.reachMultiple !== null ? `Reach · ${figures.reachMultiple}× followers` : "Reach"} />
              <MiniStat icon={<Heart className="size-[18px] text-primary" strokeWidth={2.2} />} value={figures.engagementRate !== null ? `${figures.engagementRate}%` : "–"} label="Engagement" />
              <MiniStat icon={<MousePointerClick className="size-[18px] text-warning-text" strokeWidth={2.2} />} value={stats.clicks > 0 ? formatCount(stats.clicks) : "–"} label="Clicks to Amazon" />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1.4fr_1fr_1fr]">
              <Term label="Affiliate quote" value={influencer.affiliateQuote} empty="Not on file" />
              <Term label="Fee asked" value={fee !== null ? money(fee) : null} empty="None, gifted" />
              <Term label="Collaboration" value={collab ? collab[0].toUpperCase() + collab.slice(1) : null} empty="Not agreed yet" />
            </div>
            {influencer.amazonTier ? (
              <div className="rounded-2xl border border-[#fde3b0] bg-warning-soft/60 px-4 py-3.5 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-extrabold text-foreground">Amazon Creator Connections · <span className="capitalize">{influencer.amazonTier}</span></p>
                  {influencer.amazonMonthlyGmvUsd !== null ? <p className="font-semibold text-muted-foreground">{money(influencer.amazonMonthlyGmvUsd)} a month on Amazon</p> : null}
                </div>
                <p className="mt-1 font-medium text-muted-foreground">
                  For us: {stats.clicks > 0 ? `${formatCount(stats.clicks)} clicks` : "no clicks logged"}, {stats.salesUsd > 0 ? `${money(stats.salesUsd)} in sales` : "no sales logged"}.
                </p>
              </div>
            ) : null}
            <section>
              <div className="mb-2 flex items-center">
                <h3>Reach per post</h3>
                <span className="flex-1" />
                <span className="text-[12.5px] font-semibold text-muted-foreground">{posts.length} {posts.length === 1 ? "post" : "posts"}</span>
              </div>
              {hasNumbers ? (
                <Bars data={posts.map((post) => ({ label: formatDay(post.at), value: post.views ?? 0, hint: `${post.format ?? "post"} · ${post.views !== null ? `${post.views.toLocaleString("en-US")} views` : "no views logged"}${post.salesUsd ? ` · ${money(post.salesUsd)}` : ""}` }))} color="var(--primary)" />
              ) : (
                <p className="rounded-2xl border border-dashed px-4 py-6 text-center text-sm font-medium text-muted-foreground">No numbers yet. Log them on each post in the profile&apos;s Content tab.</p>
              )}
            </section>
          </>
        ) : null}

        {tab === "history" ? (
          campaigns.length === 0 ? (
            <p className="py-6 text-center text-sm font-medium text-muted-foreground">Not in any campaign you can see.</p>
          ) : (
            <ul className="grid gap-3">
              {campaigns.map((link) => (
                <li key={link.id} className="grid gap-2 rounded-2xl border px-4 py-3.5 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/campaigns/${link.campaignId}`} className="font-bold text-foreground hover:text-primary">
                      {link.name}
                    </Link>
                    <CreatorStatusPill status={link.status} />
                    {link.fitScore !== null ? <span className="text-xs font-semibold text-muted-foreground">fit {link.fitScore}</span> : null}
                  </div>
                  {link.replyRead ? <p className="text-[13px] font-medium text-muted-foreground">Rachna: {link.replyRead}</p> : null}
                  {link.gifts.length > 0 || link.posts.length > 0 ? (
                    <ul className="grid gap-1.5 text-[13px]">
                      {link.gifts.map((gift) => (
                        <li key={gift.id} className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                          <span aria-hidden className="size-2 rounded-full bg-[#f59e0b]" />
                          <span className="font-bold text-foreground">Gift</span>
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
                          <span aria-hidden className="size-2 rounded-full bg-[#22c55e]" />
                          <a href={post.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-bold text-foreground hover:text-primary">
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
          )
        ) : null}

        {tab === "numbers" ? (
          <div className="grid gap-4 md:grid-cols-2">
            <section className="rounded-2xl border p-4">
              <h3 className="mb-1">Reach per post</h3>
              {hasNumbers ? (
                <Bars data={posts.map((post) => ({ label: formatDay(post.at), value: post.views ?? 0, hint: `${post.format ?? "post"} · ${post.views !== null ? `${post.views.toLocaleString("en-US")} views` : "no views logged"}${post.salesUsd ? ` · ${money(post.salesUsd)}` : ""}` }))} color="var(--primary)" />
              ) : (
                <p className="py-6 text-center text-sm font-medium text-muted-foreground">No numbers logged yet.</p>
              )}
            </section>
            <section className="rounded-2xl border p-4">
              <h3 className="mb-1">Last six months</h3>
              <MonthBars months={months} />
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PlatformIcon({ platform }: { platform: string }) {
  if (platform === "instagram") {
    return (
      <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth={2.2}>
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <circle cx="12" cy="12" r="4" />
        <circle cx="17.5" cy="6.5" r="1" fill="currentColor" />
      </svg>
    );
  }
  return <AtSign className="size-4" strokeWidth={2.2} />;
}

function StatTile({ icon, label, value, note, good }: { icon: React.ReactNode; label: string; value: string; note: string; good?: boolean }) {
  return (
    <div className={cn("grid content-start gap-1 rounded-2xl border px-4 py-3.5", good && "border-[#c9f0d8] bg-[#f6fef9]")}>
      <p className={cn("label flex items-center gap-1.5", good && "text-success-text")}>
        {icon}
        {label}
      </p>
      <p className={cn("stat-number text-[28px]", good && "text-[#166534]")}>{value}</p>
      <p className="text-[12.5px] font-semibold text-muted-foreground">{note}</p>
    </div>
  );
}

function MiniStat({ icon, value, label }: { icon: React.ReactNode; value: string; label: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl bg-surface-2/80 px-3 py-2.5">
      {icon}
      <span className="min-w-0">
        <b className="block text-base leading-tight font-extrabold text-foreground tabular-nums">{value}</b>
        <span className="block truncate text-xs font-bold text-muted-foreground">{label}</span>
      </span>
    </div>
  );
}

function Term({ label, value, empty }: { label: string; value: string | null; empty: string }) {
  return (
    <div className="rounded-xl border border-dashed border-[#e2c3cf] bg-[#fffafc] px-3.5 py-3">
      <p className="label">{label}</p>
      <p className={cn("mt-0.5 font-bold", value ? "text-foreground" : "text-muted-foreground")}>{value ?? empty}</p>
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

/** Plain bars, one per post, tallest to the biggest number. SVG, no library. */
function Bars({ data, color }: { data: { label: string; value: number; hint: string }[]; color: string }) {
  const width = 320;
  const height = 120;
  const pad = 4;
  const max = Math.max(1, ...data.map((point) => point.value));
  const slot = (width - pad * 2) / Math.max(1, data.length);
  const bar = Math.max(6, Math.min(28, slot * 0.6));
  return (
    <svg viewBox={`0 0 ${width} ${height + 18}`} className="mx-auto h-auto max-h-44 w-full" role="img" aria-label="Reach per post">
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
