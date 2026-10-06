export const COMPANY_NAME = "Ridhi Home and Living";

/** The brands the company trades under; both are named on the legal pages. */
export const BRAND_NAMES = "Ridhi Block Print and Cotton Print Club";

/** Shown on the privacy and terms pages. Set LEGAL_CONTACT_EMAIL to a monitored address. */
export function legalContact(): string {
  return process.env.LEGAL_CONTACT_EMAIL?.trim() || "";
}

/** The date the privacy and terms pages were last changed. Update it whenever their text changes. */
export const LEGAL_UPDATED = "6 October 2026";
