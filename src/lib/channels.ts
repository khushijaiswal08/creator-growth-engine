import type { CreatorStatus, Platform, Prisma, TemplatePurpose } from "@prisma/client";
import { PLATFORM_LABELS } from "@/lib/profile-url";
import { PRE_CONTACT_STATUSES } from "@/lib/status";

/**
 * The ways a message can reach a creator. Instagram, TikTok and YouTube are a
 * DM or profile the browser opens; Amazon is the message thread inside
 * Creator Connections, which only the Ads console can show; email opens the
 * person's mail app. Nothing is sent from the portal on any of them: the
 * text is copied or prefilled, the person presses send, the portal logs it.
 */
export type Channel = "dm" | "email" | "amazon";

export type Destination = {
  key: string;
  channel: Channel;
  socialProfileId: string | null;
  platform: Platform | null;
  handle: string | null;
  email: string | null;
  /** What the picker shows, e.g. "Instagram DM @handle", "Amazon Creator Connections", "Email name@x". */
  label: string;
  /** What the templates' {platform} becomes. */
  platformWord: string;
};

export const AMAZON_CONSOLE_URL = "https://advertising.amazon.com/";

type Reachable = {
  profiles: { id: string; platform: Platform; handle: string }[];
  /** The creator's email, when known. */
  email?: string | null;
  /** True for creators who came through Amazon Creator Connections (they carry an Amazon tier). */
  amazonCreator?: boolean;
};

export type MessageTarget = {
  campaignCreatorId: string;
  influencerName: string;
  status: CreatorStatus;
  profiles: { id: string; platform: Platform; handle: string }[];
  /** Why this creator must not be messaged (suppression list, blocked status, archived). */
  blockedReason: string | null;
  /** The template the next action calls for, when the caller knows it. */
  purpose?: TemplatePurpose | null;
  /** The creator's email, when known: offers the email channel. */
  email?: string | null;
  /** A Creator Connections creator: offers the Amazon channel. */
  amazonCreator?: boolean;
};

/** What a list selects about a creator so the Message button can reach them, plus followers for the card. */
export const REACHABLE_INFLUENCER_SELECT = {
  id: true,
  name: true,
  email: true,
  amazonTier: true,
  profiles: { select: { id: true, platform: true, handle: true, followers: true }, orderBy: { platform: "asc" } },
} as const satisfies Prisma.InfluencerSelect;

export function destinationsFor(target: Reachable): Destination[] {
  const out: Destination[] = target.profiles.map((profile) => ({
    key: `dm:${profile.id}`,
    channel: "dm",
    socialProfileId: profile.id,
    platform: profile.platform,
    handle: profile.handle,
    email: null,
    label: `${profile.platform === "instagram" ? "Instagram DM" : PLATFORM_LABELS[profile.platform]} @${profile.handle}`,
    platformWord: PLATFORM_LABELS[profile.platform],
  }));
  if (target.amazonCreator) {
    out.push({ key: "amazon", channel: "amazon", socialProfileId: null, platform: null, handle: null, email: null, label: "Amazon Creator Connections", platformWord: "Amazon" });
  }
  if (target.email) {
    out.push({ key: "email", channel: "email", socialProfileId: null, platform: null, handle: null, email: target.email, label: `Email ${target.email}`, platformWord: "email" });
  }
  return out;
}

/** The line under a creator's name: their handle, else where they can be reached, else "No profile". */
export function reachLabel(target: { handle: string | null; amazonCreator: boolean; email: string | null }): string {
  return target.handle ?? (target.amazonCreator ? "Amazon Creator Connections" : (target.email ?? "No profile"));
}

/**
 * Where to start: a Creator Connections creator who has not been contacted yet
 * is reached inside Amazon first (that is where they applied); afterwards the
 * conversation moves to a DM or email, so those come first once they exist.
 */
export function defaultDestination(destinations: Destination[], status: CreatorStatus): Destination | null {
  if (destinations.length === 0) return null;
  const amazon = destinations.find((destination) => destination.channel === "amazon");
  if (amazon && PRE_CONTACT_STATUSES.has(status)) return amazon;
  return destinations.find((destination) => destination.channel !== "amazon") ?? destinations[0];
}

const isAmazonTemplate = (template: { name: string }) => /amazon/i.test(template.name);

/**
 * The template for a purpose on a channel. Templates whose name mentions
 * Amazon are written for the Creator Connections thread (short, asking for
 * an email or handle) and are used only there. With no welcome-back
 * template left, a creator invited back gets the usual first message.
 */
export function pickTemplate<T extends { id: string; name: string; purpose: string }>(templates: T[], purpose: string, channel: Channel): T | undefined {
  const forPurpose = templates.filter((template) => template.purpose === purpose);
  if (forPurpose.length === 0 && purpose === "welcome_back") return pickTemplate(templates, "first", channel);
  const amazonOnes = forPurpose.filter(isAmazonTemplate);
  const plainOnes = forPurpose.filter((template) => !isAmazonTemplate(template));
  if (channel === "amazon") return amazonOnes[0] ?? plainOnes[0] ?? templates[0];
  return plainOnes[0] ?? amazonOnes[0] ?? templates[0];
}

/** A mail link the browser hands to the person's mail app, with the message ready. */
export function mailtoFor(email: string, subject: string, body: string): string {
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
