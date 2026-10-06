import type { Metadata } from "next";
import { BRAND_NAMES, COMPANY_NAME, LEGAL_UPDATED, legalContact } from "@/lib/legal";

export const metadata: Metadata = { title: "Terms" };

export default function TermsPage() {
  const contact = legalContact();

  return (
    <>
      <h1 className="text-[28px] leading-tight">Terms of use</h1>
      <p className="text-muted-foreground">
        {COMPANY_NAME}. Last updated {LEGAL_UPDATED}.
      </p>

      <h2>Who may use this tool</h2>
      <p>
        Creator Growth Engine is an internal tool of {COMPANY_NAME}, used for the brands {BRAND_NAMES}. Only people given an account by a {COMPANY_NAME}{" "}
        administrator may use it. Accounts are personal: do not share your password, and tell an administrator at once
        if you think someone else has used your account.
      </p>

      <h2>Acceptable use</h2>
      <ul>
        <li>Use the tool only for {COMPANY_NAME} marketing work.</li>
        <li>
          Do not contact anyone marked &quot;Do not contact&quot;, and add anyone who asks not to be contacted to that
          list.
        </li>
        <li>
          Messages are sent by you, from your own account on the platform. Follow that platform&apos;s rules and keep
          messages honest about who you are and what is being offered.
        </li>
        <li>
          When a creator posts about a gifted product, ask them to disclose it as required by the US Federal Trade
          Commission&apos;s endorsement guides.
        </li>
        <li>Do not export or copy creator information for any purpose outside {COMPANY_NAME}&apos;s work.</li>
      </ul>

      <h2>Third-party services</h2>
      <p>
        The tool uses YouTube API Services, so using it means you also agree to be bound by the{" "}
        <a className="link" href="https://www.youtube.com/t/terms" rel="noopener noreferrer" target="_blank">
          YouTube Terms of Service
        </a>
        . It also uses Meta&apos;s Graph API and Anthropic&apos;s API under their own terms.
      </p>

      <h2>AI fit scores</h2>
      <p>
        Fit scores are suggestions produced by an AI model and can be wrong. They are never a decision. A person
        reviews every creator before anyone is approved or contacted.
      </p>

      <h2>Records</h2>
      <p>
        What you do in the tool (status changes, messages logged, imports, approvals) is recorded with your name and
        the time, and can be seen by your team.
      </p>

      <h2>Availability</h2>
      <p>The tool is provided as is for internal use, and may be changed or taken offline for maintenance.</p>

      {contact ? (
        <>
          <h2>Questions</h2>
          <p>
            Write to{" "}
            <a className="link" href={`mailto:${contact}`}>
              {contact}
            </a>
            .
          </p>
        </>
      ) : null}
    </>
  );
}
