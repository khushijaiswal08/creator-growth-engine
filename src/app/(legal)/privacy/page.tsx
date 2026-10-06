import type { Metadata } from "next";
import { BRAND_NAMES, COMPANY_NAME, LEGAL_UPDATED, legalContact } from "@/lib/legal";

export const metadata: Metadata = { title: "Privacy" };

export default function PrivacyPage() {
  const contact = legalContact();

  return (
    <>
      <h1 className="text-[28px] leading-tight">Privacy</h1>
      <p className="text-muted-foreground">
        {COMPANY_NAME}. Last updated {LEGAL_UPDATED}.
      </p>

      <h2>What this tool is</h2>
      <p>
        Creator Growth Engine is an internal tool used by the {COMPANY_NAME} marketing team, for its brands {BRAND_NAMES},
        to find, review, contact and keep track of social media creators we would like to work with. It is not open to the public and has no
        sign-up.
      </p>

      <h2>Whose information we hold</h2>
      <ul>
        <li>
          <strong>Creators.</strong> Information from public profiles on Instagram, TikTok and YouTube: handle, display
          name, bio, follower or subscriber count, country when the platform shows it, and recent post captions or
          video titles. We also hold an email address when a creator has published one or given it to us, and our own
          notes about our contact with them.
        </li>
        <li>
          <strong>Creators who accept a gift.</strong> The name, shipping address and phone number they give us through
          their private product-selection link, so that we can ship the gift. The link is unique to them, works for 14
          days and once, and these details are stored encrypted and shown only to the team of the brand that sent the gift.
        </li>
        <li>
          <strong>Team members.</strong> Name, work email, a hashed password, and a log of the actions they take in the
          tool.
        </li>
      </ul>

      <h2>Where the information comes from</h2>
      <ul>
        <li>Entered or imported by our team.</li>
        <li>
          YouTube API Services, used to find channels by keyword. Use of YouTube data is subject to the{" "}
          <a className="link" href="https://www.youtube.com/t/terms" rel="noopener noreferrer" target="_blank">
            YouTube Terms of Service
          </a>{" "}
          and the{" "}
          <a className="link" href="https://policies.google.com/privacy" rel="noopener noreferrer" target="_blank">
            Google Privacy Policy
          </a>
          .
        </li>
        <li>Meta&apos;s Graph API for Instagram, used to find public posts by hashtag and read public account statistics.</li>
      </ul>

      <h2>How we use it</h2>
      <ul>
        <li>To decide whether a creator is a good fit for a campaign, and to contact them about it.</li>
        <li>
          To keep a record of who was contacted, when, and what was agreed, so a creator is not contacted twice or
          after asking us to stop.
        </li>
        <li>
          An AI model (Anthropic&apos;s Claude) produces a fit score to help our reviewers. It is sent a creator&apos;s
          public bio, captions, follower counts and country, not their name, handle or email address. A person on our team makes every
          decision; the score never approves or rejects anyone by itself.
        </li>
      </ul>
      <p>We do not sell this information, and we do not send messages automatically.</p>

      <h2>Who it is shared with</h2>
      <p>
        Only the companies that run the tool for us: our hosting provider (Netlify), our database provider (Neon) and
        Anthropic for the fit score. Each handles the information on our behalf.
      </p>

      <h2>How long we keep it</h2>
      <p>
        For as long as we are working with a creator or may do so again. Records are archived rather than deleted so
        that a request not to be contacted keeps being honoured.
      </p>

      <h2>Your choices</h2>
      <p>
        If you are a creator and want to know what we hold about you, have it corrected or removed, or do not want to
        hear from us again, {contact ? (
          <>
            write to{" "}
            <a className="link" href={`mailto:${contact}`}>
              {contact}
            </a>
          </>
        ) : (
          <>reply to any message from our team</>
        )}
        . We add you to our do-not-contact list and that applies to every campaign.
      </p>
    </>
  );
}
