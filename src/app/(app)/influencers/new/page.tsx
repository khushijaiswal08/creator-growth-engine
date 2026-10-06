import type { Metadata } from "next";
import Link from "next/link";
import { AddInfluencerForm } from "@/components/add-influencer-form";
import { BookmarkletLink } from "@/components/bookmarklet-link";
import { PageHeader, Panel } from "@/components/panel";
import { CreatorStatusPill, Pill } from "@/components/status-pill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { allowed, viewed } from "@/lib/brand-scope";
import { db } from "@/lib/db";
import { formatDay } from "@/lib/format";
import { displayHandle, parseProfileUrl, PLATFORM_LABELS } from "@/lib/profile-url";
import { appBaseUrl } from "@/lib/selection";
import { requireUser } from "@/lib/session";
import { loadSuppressions } from "@/lib/suppression";
import { describeTrackRecord, trackRecordFor } from "@/lib/track-record";

export const metadata: Metadata = { title: "Add or check a creator" };

/**
 * The first stop before contacting anyone. Paste a profile link (or arrive
 * here from the bookmark on the creator's page) and the portal says whether
 * the person is already known, by whom, with what outcome, before a single
 * message is sent. The add form below is filled in either way.
 */
export default async function NewInfluencerPage({
  searchParams,
}: {
  searchParams: Promise<{ campaignId?: string; url?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const url = (params.url ?? "").trim().slice(0, 500);
  const scope = allowed(user);
  const view = viewed(user);

  const [campaigns, portalUrl] = await Promise.all([
    db.campaign.findMany({
      where: { ...view.campaigns, status: { not: "archived" } },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    appBaseUrl(),
  ]);
  const defaultCampaignId = campaigns.some((campaign) => campaign.id === params.campaignId) ? params.campaignId! : "";

  // What the portal knows about the profile that was pasted or sent by the bookmark.
  let lookup: React.ReactNode = null;
  let joined = new Set<string>();
  if (url) {
    const parsed = parseProfileUrl(url);
    if (!parsed.ok) {
      lookup = <p className="rounded-md border border-destructive/30 bg-danger-soft px-3 py-2 text-danger-text">{parsed.error}</p>;
    } else {
      const label = `${PLATFORM_LABELS[parsed.profile.platform]} ${displayHandle(parsed.profile.handle)}`;
      const profile = await db.socialProfile.findUnique({ where: { platform_handle: parsed.profile }, select: { influencerId: true } });
      const influencer = profile
        ? await db.influencer.findFirst({
            where: { id: profile.influencerId, ...scope.influencers },
            select: {
              id: true,
              name: true,
              email: true,
              location: true,
              archived: true,
              profiles: { select: { platform: true, handle: true } },
              campaigns: {
                where: view.creators,
                orderBy: { createdAt: "desc" },
                select: { campaignId: true, status: true, lastContactedAt: true, campaign: { select: { name: true } }, owner: { select: { name: true } } },
              },
            },
          })
        : null;

      if (!profile) {
        lookup = (
          <p className="rounded-md bg-success-soft px-3 py-2 text-success-text">
            {label} is not in the portal yet. Nobody here has contacted them. Add them below.
          </p>
        );
      } else if (!influencer) {
        lookup = (
          <p className="rounded-md bg-warning-soft px-3 py-2 text-warning-text">
            {label} is already in the portal through the other brand&apos;s campaigns. Adding them to one of your campaigns below makes
            them visible to you; check with the other team before messaging, so they are not approached twice.
          </p>
        );
      } else {
        joined = new Set(influencer.campaigns.map((link) => link.campaignId));
        const [records, suppressions] = await Promise.all([trackRecordFor([influencer.id], view), loadSuppressions([influencer])]);
        const record = describeTrackRecord(records.get(influencer.id));
        const suppressed = suppressions.reasonFor(influencer);
        lookup = (
          <div className="grid gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">Already in the portal as</span>
              <Link href={`/influencers/${influencer.id}`} className="link font-medium">
                {influencer.name}
              </Link>
              {influencer.archived ? <Pill tone="neutral">Archived</Pill> : null}
              {suppressed ? <Pill tone="danger">Do not contact: {suppressed}</Pill> : null}
              {record ? <Pill tone={record.tone}>{record.text}</Pill> : null}
            </div>
            {influencer.campaigns.length === 0 ? (
              <p className="text-muted-foreground">Not in any of your campaigns yet, so nobody on your side has contacted them.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Campaign</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Last contacted</TableHead>
                    <TableHead>Owner</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {influencer.campaigns.map((link) => (
                    <TableRow key={link.campaignId}>
                      <TableCell>
                        <Link href={`/campaigns/${link.campaignId}`} className="link">
                          {link.campaign.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <CreatorStatusPill status={link.status} />
                      </TableCell>
                      <TableCell>{formatDay(link.lastContactedAt) || "Never"}</TableCell>
                      <TableCell>{link.owner?.name ?? "Unassigned"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <div>
              <Button asChild variant="action">
                <Link href={`/influencers/${influencer.id}`}>Open {influencer.name}</Link>
              </Button>
            </div>
          </div>
        );
      }
    }
  }
  const openCampaigns = campaigns.filter((campaign) => !joined.has(campaign.id));

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Add or check a creator" meta="Paste a profile link first: the portal tells you if anyone here has contacted them already." />

      <Panel title="Check a profile" className="mb-4">
        <form method="get" className="flex flex-wrap items-end gap-2 p-4">
          <label className="grid flex-1 gap-1.5 text-sm font-medium">
            Profile link
            <Input name="url" type="url" defaultValue={url} placeholder="https://www.instagram.com/handle/" inputMode="url" required />
          </label>
          {defaultCampaignId ? <input type="hidden" name="campaignId" value={defaultCampaignId} /> : null}
          <Button type="submit">Check</Button>
        </form>
        {lookup ? <div className="border-t p-4">{lookup}</div> : null}
      </Panel>

      <Panel title={joined.size > 0 ? "Add to another campaign" : "Add the creator"} className="mb-4">
        {/* A creator belongs to a brand through a campaign, so someone tied to one brand must pick one. */}
        <AddInfluencerForm
          campaigns={openCampaigns}
          defaultCampaignId={joined.has(defaultCampaignId) ? "" : defaultCampaignId}
          campaignRequired={user.brandId !== null}
          defaultUrl={url}
        />
      </Panel>

      <Panel title="Quicker from Instagram">
        <div className="grid gap-3 p-4">
          <p>
            Drag this button to your browser&apos;s bookmarks bar once. Then, on any Instagram, TikTok or YouTube profile, click it:
            this screen opens with that profile already filled in and checked.
          </p>
          <div>
            <BookmarkletLink portalUrl={portalUrl} label="Check in Creator Growth Engine" />
          </div>
          <p className="text-xs text-muted-foreground">
            If the bookmarks bar is hidden, press Ctrl+Shift+B in Chrome or Edge. The bookmark points at {portalUrl}; make a new one
            from this page if the portal&apos;s address changes.
          </p>
        </div>
      </Panel>
    </div>
  );
}
