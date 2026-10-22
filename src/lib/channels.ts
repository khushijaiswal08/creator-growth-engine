import type { CreatorStatus, Platform } from "@prisma/client";
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

export type Reachable = {
  profiles: { id: string; platform: Platform; handle: string }[];
  /** The creator's email, when known. */
  email?: string | null;
  /** True for creators who came through Amazon Creator Connections (they carry an Amazon tier). */
  amazonCreator?: boolean;
};

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

/**
 * The template for a purpose on a channel. Templates whose name mentions
 * Amazon are written for the Creator Connections thread (short, asking for
 * an email or handle) and are used only there.
 */
export function pickTemplate<T extends { id: string; name: string; purpose: string }>(templates: T[], purpose: string, channel: Channel): T | undefined {
  const forPurpose = templates.filter((template) => template.purpose === purpose);
  const amazonOnes = forPurpose.filter((template) => /amazon/i.test(template.name));
  const plainOnes = forPurpose.filter((template) => !/amazon/i.test(template.name));
  if (channel === "amazon") return amazonOnes[0] ?? plainOnes[0] ?? templates[0];
  return plainOnes[0] ?? amazonOnes[0] ?? templates[0];
}

/** A mail link the browser hands to the person's mail app, with the message ready. */
export function mailtoFor(email: string, subject: string, body: string): string {
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
