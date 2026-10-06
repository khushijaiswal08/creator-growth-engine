import type { Prisma, PrismaClient } from "@prisma/client";

export const ACTIVITY_KINDS = [
  "status_change",
  "message_logged",
  "influencer_created",
  "influencer_updated",
  "influencer_archived",
  "influencer_unarchived",
  "profile_added",
  "added_to_campaign",
  "campaign_created",
  "csv_import",
  "discovery_run",
  "scoring_run",
  "review_decision",
  "suppression_added",
  "suppression_removed",
  "template_saved",
  "user_admin",
  "sample_archived",
  "note",
] as const;

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_KIND_LABELS: Record<ActivityKind, string> = {
  status_change: "Status",
  message_logged: "Message",
  influencer_created: "Created",
  influencer_updated: "Edited",
  influencer_archived: "Archived",
  influencer_unarchived: "Restored",
  profile_added: "Profile",
  added_to_campaign: "Campaign",
  campaign_created: "Campaign",
  csv_import: "Import",
  discovery_run: "Discovery",
  scoring_run: "Scoring",
  review_decision: "Review",
  suppression_added: "Blocked",
  suppression_removed: "Unblocked",
  template_saved: "Template",
  user_admin: "Users",
  sample_archived: "Archived",
  note: "Note",
};

type ActivityInput = {
  userId: string;
  kind: ActivityKind;
  body: string;
  influencerId?: string | null;
  campaignCreatorId?: string | null;
};

/** Every status change and message goes through here. Pass the transaction client when inside one. */
export function logActivity(client: PrismaClient | Prisma.TransactionClient, input: ActivityInput) {
  return client.activity.create({ data: input });
}
