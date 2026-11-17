import type { Metadata } from "next";
import { BRAND_NAMES, COMPANY_NAME, LEGAL_UPDATED, legalContact } from "@/lib/legal";

export const metadata: Metadata = { title: "Ask us to stop using your data" };

export default function DataDeletionPage() {
  const contact = legalContact();

  return (
    <>
      <h1 className="text-[28px] leading-tight">Ask us to stop using your data</h1>
      <p className="text-muted-foreground">
        {COMPANY_NAME}. Last updated {LEGAL_UPDATED}.
      </p>

      <h2>Who this is for</h2>
      <p>
        Creator Setu is an internal tool of {COMPANY_NAME} for its brands {BRAND_NAMES}. We keep a record of creators we
        may work with, using information from their public profiles on Instagram, TikTok and YouTube. If you are one of those
        creators and you want us to stop using your information, this page explains how.
      </p>

      <h2>How to ask</h2>
      <ol>
        <li>
          Send a message to{" "}
          {contact ? (
            <a className="link" href={`mailto:${contact}`}>
              {contact}
            </a>
          ) : (
            <>our team by replying to any message we have sent you</>
          )}{" "}
          saying that you want us to stop using your data.
        </li>
        <li>Include your Instagram, TikTok or YouTube handle, so we can find your record.</li>
      </ol>

      <h2>What happens next</h2>
      <ul>
        <li>We take you out of every active campaign and mark you as do-not-contact for all of our brands.</li>
        <li>We stop using the information we collected from Instagram or any other platform.</li>
        <li>
          We do not delete the record itself. It stays in our archive, so that we never contact you again, and it is not used for
          any campaign.
        </li>
      </ul>
      <p>
        See our <a className="link" href="/privacy">privacy page</a> for what we hold and who it is shared with.
      </p>
    </>
  );
}
