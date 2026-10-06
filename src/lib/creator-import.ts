import { createId } from "@paralleldrive/cuid2";
import type { CreatorStatus, Platform, Prisma } from "@prisma/client";
import type { ActivityKind } from "@/lib/activity";
import type { BrandScope } from "@/lib/brand-scope";
import { parseCreatorCsv } from "@/lib/csv";
import { db } from "@/lib/db";
import { displayHandle } from "@/lib/profile-url";
import { CREATOR_STATUS_LABELS } from "@/lib/status";

export type ImportOutcome = "added" | "updated" | "skipped";

export type ImportDetail = {
  row: number;
  platform: string;
  handle: string;
  outcome: ImportOutcome;
  notes: string[];
};

export type ImportReport =
  | { ok: false; error: string }
  | {
      ok: true;
      fileName: string;
      added: number;
      updated: number;
      skipped: number;
      ignoredColumns: string[];
      details: ImportDetail[];
      /** The campaigns rows were added to, so the screens that show them can be refreshed. */
      campaignIds: string[];
    };

export type ImportOptions = {
  /** Who the import is recorded under in the activity log. */
  userId: string;
  /** Which campaigns may be named in the file or chosen on the form. */
  scope: BrandScope;
  /** Where rows go that name no campaign, or an unknown one. "" means nowhere. */
  fallbackCampaignId: string;
  fileName: string;
  /** Work everything out and report it, but write nothing. */
  checkOnly?: boolean;
};

// In-memory picture of the records the file touches. `isNew` marks records
// that do not exist yet and will be inserted at the end.
type KnownInfluencer = {
  id: string;
  name: string;
  email: string | null;
  location: string | null;
  notes: string | null;
  archived: boolean;
  isNew: boolean;
};

type KnownProfile = {
  id: string;
  platform: Platform;
  handle: string;
  followers: number | null;
  influencer: KnownInfluencer;
  isNew: boolean;
};

type KnownLink = {
  id: string;
  campaignId: string;
  influencerId: string;
  ownerId: string | null;
  status: CreatorStatus;
  isNew: boolean;
};

type InfluencerFills = Partial<Pick<KnownInfluencer, "name" | "email" | "location" | "notes">>;

const profileKey = (platform: Platform, handle: string) => `${platform}:${handle}`;
const linkKey = (campaignId: string, influencerId: string) => `${campaignId}:${influencerId}`;

/** How a note from a file starts when it is kept in the activity instead of on the person. */
export const IMPORTED_NOTE = "Imported note: ";

/**
 * Imports creators from CSV text. Dedupes on (platform, handle); for profiles
 * that already exist only blank fields are filled, never overwritten.
 *
 * The file is first worked out entirely in memory, then saved in one
 * transaction with a handful of bulk statements. That keeps a large file to a
 * few database round trips, and means a failed import changes nothing.
 *
 * A row goes into the campaign it names, or else into the fallback campaign.
 * Only campaigns inside the scope can be named or chosen, and someone tied to
 * one brand must choose one: a creator belongs to a brand through a campaign,
 * so otherwise they would import people they cannot see.
 *
 * Used by the CSV import screen and by scripts/import-creators.ts.
 */
export async function importCreators(text: string, options: ImportOptions): Promise<ImportReport> {
  const { userId, scope, fallbackCampaignId, fileName } = options;

  const parsed = parseCreatorCsv(text);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const { rows } = parsed;

  if (scope.brandId && !fallbackCampaignId) return { ok: false, error: "Choose the campaign these creators belong to." };

  // Load everything the rows can refer to up front.
  const influencerSelect = { id: true, name: true, email: true, location: true, notes: true, archived: true };
  const emails = [...new Set(rows.flatMap((row) => (row.email ? [row.email] : [])))];
  const [existingProfiles, existingByEmail, campaigns, users] = await Promise.all([
    // Handles are unique across both brands, so the lookups that dedupe are deliberately not limited to one.
    db.socialProfile.findMany({
      where: { handle: { in: [...new Set(rows.map((row) => row.handle))] } },
      select: { id: true, platform: true, handle: true, followers: true, influencer: { select: influencerSelect } },
    }),
    db.influencer.findMany({
      where: { email: { in: emails } },
      select: influencerSelect,
      orderBy: { createdAt: "asc" },
    }),
    // Only campaigns inside the scope can be named in the file or chosen on the form.
    db.campaign.findMany({ where: scope.campaigns, select: { id: true, name: true } }),
    db.user.findMany({ select: { id: true, email: true } }),
  ]);

  const campaignByName = new Map(campaigns.map((c) => [c.name.toLowerCase(), c]));
  const fallback = fallbackCampaignId ? campaigns.find((c) => c.id === fallbackCampaignId) : undefined;
  if (fallbackCampaignId && !fallback) return { ok: false, error: "That campaign no longer exists. Choose another." };
  /** The campaign a row goes into: the one it names, or else the one chosen on the form. */
  const campaignFor = (row: { campaign: string | null }) =>
    (row.campaign ? campaignByName.get(row.campaign.toLowerCase()) : undefined) ?? fallback;
  const userIdByEmail = new Map(users.map((u) => [u.email.toLowerCase(), u.id]));

  // One shared object per influencer, so a fill made by one row is seen by the next.
  const influencerById = new Map<string, KnownInfluencer>();
  const shareInfluencer = (found: Omit<KnownInfluencer, "isNew">) => {
    let shared = influencerById.get(found.id);
    if (!shared) {
      shared = { ...found, isNew: false };
      influencerById.set(found.id, shared);
    }
    return shared;
  };

  const profileMap = new Map<string, KnownProfile>();
  for (const p of existingProfiles) {
    profileMap.set(profileKey(p.platform, p.handle), {
      id: p.id,
      platform: p.platform,
      handle: p.handle,
      followers: p.followers,
      influencer: shareInfluencer(p.influencer),
      isNew: false,
    });
  }
  const influencerByEmail = new Map<string, KnownInfluencer>();
  for (const found of existingByEmail) {
    const shared = shareInfluencer(found);
    if (shared.email && !influencerByEmail.has(shared.email)) influencerByEmail.set(shared.email, shared);
  }

  const referencedCampaignIds = [
    ...new Set(
      rows.flatMap((row) => {
        const campaign = campaignFor(row);
        return campaign ? [campaign.id] : [];
      }),
    ),
  ];
  const [existingLinks, earlierNotes] = await Promise.all([
    db.campaignCreator.findMany({
      where: { campaignId: { in: referencedCampaignIds } },
      select: { id: true, campaignId: true, influencerId: true, ownerId: true, status: true },
    }),
    // Notes kept from earlier imports, so running the same file twice does not repeat them.
    db.activity.findMany({
      where: { kind: "note", body: { startsWith: IMPORTED_NOTE }, influencerId: { in: [...influencerById.keys()] } },
      select: { influencerId: true, campaignCreatorId: true, body: true },
    }),
  ]);
  const linkMap = new Map<string, KnownLink>(
    existingLinks.map((l) => [linkKey(l.campaignId, l.influencerId), { ...l, isNew: false }]),
  );
  const notedAlready = new Set(earlierNotes.map((note) => `${note.campaignCreatorId ?? note.influencerId}|${note.body}`));

  // What will be written once every row has been worked out.
  const newInfluencers: KnownInfluencer[] = [];
  const newProfiles: KnownProfile[] = [];
  const newLinks: KnownLink[] = [];
  const influencerUpdates = new Map<string, InfluencerFills>();
  const followerUpdates = new Map<string, number>();
  const ownerUpdates = new Map<string, string>();
  const activities: Prisma.ActivityCreateManyInput[] = [];
  const log = (kind: ActivityKind, body: string, ids: { influencerId?: string; campaignCreatorId?: string }) =>
    activities.push({ userId, kind, body, ...ids });

  const details: ImportDetail[] = parsed.errors.map((error) => ({
    row: error.row,
    platform: error.platform,
    handle: error.handle,
    outcome: "skipped",
    notes: [error.reason],
  }));

  for (const row of rows) {
    const notes = [...row.warnings];
    const label = `${row.platform} ${displayHandle(row.handle)}`;
    const key = profileKey(row.platform, row.handle);
    let outcome: ImportOutcome = "skipped";

    const campaign = campaignFor(row);
    if (row.campaign && !campaignByName.has(row.campaign.toLowerCase())) {
      notes.push(
        campaign
          ? `Campaign "${row.campaign}" not found; added to "${campaign.name}" instead.`
          : `Campaign "${row.campaign}" not found; not attached to a campaign.`,
      );
    }
    if (!campaign && row.status) notes.push("Status ignored because the row has no campaign.");

    const ownerId = row.ownerEmail ? userIdByEmail.get(row.ownerEmail) : undefined;
    if (row.ownerEmail && !ownerId) notes.push(`Owner ${row.ownerEmail} is not a user; left unassigned.`);

    let influencer: KnownInfluencer;
    const known = profileMap.get(key);

    if (known) {
      influencer = known.influencer;
      if (known.followers === null && row.followers !== null) {
        known.followers = row.followers;
        if (!known.isNew) followerUpdates.set(known.id, row.followers);
        notes.push("Filled followers.");
        outcome = "updated";
      }
    } else {
      const sameEmail = row.email ? influencerByEmail.get(row.email) : undefined;
      if (sameEmail) {
        // Same person on another platform: add the profile to the influencer we already have.
        influencer = sameEmail;
        log("profile_added", `Added profile ${label} by CSV import (matched on email).`, {
          influencerId: influencer.id,
        });
        notes.push(`Added as a new profile of ${influencer.name} (same email).`);
      } else {
        influencer = {
          id: createId(),
          name: row.name ?? row.handle,
          email: row.email,
          location: row.location,
          notes: row.notes,
          archived: false,
          isNew: true,
        };
        newInfluencers.push(influencer);
        influencerById.set(influencer.id, influencer);
        if (influencer.email && !influencerByEmail.has(influencer.email)) {
          influencerByEmail.set(influencer.email, influencer);
        }
        log("influencer_created", `Created by CSV import (${label}).`, { influencerId: influencer.id });
      }
      const profile: KnownProfile = {
        id: createId(),
        platform: row.platform,
        handle: row.handle,
        followers: row.followers,
        influencer,
        isNew: true,
      };
      newProfiles.push(profile);
      profileMap.set(key, profile);
      outcome = "added";
    }

    // Fill blank influencer fields. A name equal to the handle is a placeholder, so it counts as blank.
    const fills: InfluencerFills = {};
    if (row.name && row.name !== influencer.name && influencer.name === row.handle) fills.name = row.name;
    if (!influencer.email && row.email) fills.email = row.email;
    if (!influencer.location && row.location) fills.location = row.location;
    if (!influencer.notes && row.notes) fills.notes = row.notes;

    const filled = Object.keys(fills);
    if (filled.length > 0) {
      Object.assign(influencer, fills);
      if (fills.email && !influencerByEmail.has(fills.email)) influencerByEmail.set(fills.email, influencer);
      // A record created by this import simply gets inserted with the filled values.
      if (!influencer.isNew) {
        influencerUpdates.set(influencer.id, { ...influencerUpdates.get(influencer.id), ...fills });
        log("influencer_updated", `CSV import filled blank fields: ${filled.join(", ")}.`, {
          influencerId: influencer.id,
        });
      }
      if (outcome === "skipped") {
        notes.push(`Filled ${filled.join(", ")}.`);
        outcome = "updated";
      }
    }

    // A note the person already has is never overwritten. When the file's note is a different one,
    // it is kept in the creator's activity for that campaign, so what the file says is not lost
    // (another brand's notes about the same person stay where they were).
    const unplacedNote = row.notes && influencer.notes && influencer.notes !== row.notes ? `${IMPORTED_NOTE}${row.notes}` : null;

    if (campaign) {
      const lKey = linkKey(campaign.id, influencer.id);
      const link = linkMap.get(lKey);
      // The id the link has, or will have once it is written below.
      const linkId = link?.id ?? createId();
      if (unplacedNote) {
        const noteKey = `${linkId}|${unplacedNote}`;
        if (!notedAlready.has(noteKey)) {
          notedAlready.add(noteKey);
          activities.push({ userId, kind: "note", body: unplacedNote, influencerId: influencer.id, campaignCreatorId: linkId });
          notes.push("The note from the file was kept in the activity, because the person already had a different note.");
          if (outcome === "skipped") outcome = "updated";
        }
      }
      if (!link) {
        const status = row.status ?? "discovered";
        const created: KnownLink = {
          id: linkId,
          campaignId: campaign.id,
          influencerId: influencer.id,
          ownerId: ownerId ?? null,
          status,
          isNew: true,
        };
        newLinks.push(created);
        linkMap.set(lKey, created);
        log(
          "added_to_campaign",
          `Added to campaign "${campaign.name}" as ${CREATOR_STATUS_LABELS[status]} by CSV import.`,
          { influencerId: influencer.id, campaignCreatorId: created.id },
        );
        if (outcome === "skipped") {
          notes.push(`Added to campaign "${campaign.name}".`);
          outcome = "updated";
        }
      } else {
        if (!link.ownerId && ownerId) {
          link.ownerId = ownerId;
          if (!link.isNew) ownerUpdates.set(link.id, ownerId);
          if (outcome === "skipped") {
            notes.push("Filled owner.");
            outcome = "updated";
          }
        }
        if (row.status && row.status !== link.status) {
          notes.push(`Already in "${campaign.name}" as ${CREATOR_STATUS_LABELS[link.status]}; status not changed.`);
        }
      }
    }

    if (outcome === "skipped") notes.push("Already exists; no blank fields to fill.");
    if (influencer.archived) notes.push("Influencer is archived.");
    details.push({ row: row.row, platform: row.platform, handle: row.handle, outcome, notes });
  }

  details.sort((a, b) => a.row - b.row);
  const count = (outcome: ImportOutcome) => details.filter((d) => d.outcome === outcome).length;
  const added = count("added");
  const updated = count("updated");
  const skipped = count("skipped");

  const report = { ok: true as const, fileName, added, updated, skipped, ignoredColumns: parsed.ignoredColumns, details, campaignIds: referencedCampaignIds };
  if (options.checkOnly) return report;

  log("csv_import", `Imported "${fileName}": ${added} added, ${updated} updated, ${skipped} skipped.`, {});

  // Parents before children; the activity rows last because they point at everything else.
  const writes: Prisma.PrismaPromise<unknown>[] = [];
  if (newInfluencers.length > 0) {
    writes.push(
      db.influencer.createMany({
        data: newInfluencers.map(({ id, name, email, location, notes }) => ({ id, name, email, location, notes })),
      }),
    );
  }
  if (newProfiles.length > 0) {
    writes.push(
      db.socialProfile.createMany({
        data: newProfiles.map((p) => ({
          id: p.id,
          influencerId: p.influencer.id,
          platform: p.platform,
          handle: p.handle,
          followers: p.followers,
          source: "csv" as const,
        })),
      }),
    );
  }
  if (newLinks.length > 0) {
    writes.push(
      db.campaignCreator.createMany({
        data: newLinks.map(({ id, campaignId, influencerId, ownerId, status }) => ({
          id,
          campaignId,
          influencerId,
          ownerId,
          status,
        })),
      }),
    );
  }
  for (const [id, data] of influencerUpdates) writes.push(db.influencer.update({ where: { id }, data }));
  for (const [id, followers] of followerUpdates) {
    writes.push(db.socialProfile.update({ where: { id }, data: { followers } }));
  }
  for (const [id, ownerId] of ownerUpdates) {
    writes.push(db.campaignCreator.update({ where: { id }, data: { ownerId } }));
  }
  writes.push(db.activity.createMany({ data: activities }));

  try {
    await db.$transaction(writes);
  } catch (error) {
    console.error("CSV import failed", error);
    return {
      ok: false,
      error:
        "The import could not be saved, so nothing was changed. This can happen if someone added one of these creators at the same moment. Try again.",
    };
  }

  return report;
}
