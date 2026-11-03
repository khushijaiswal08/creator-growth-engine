import nodemailer from "nodemailer";

/**
 * Outgoing email for the weekly summary only. Never used to write to creators.
 * Configured with SMTP_URL (for example smtps://user:app-password@smtp.gmail.com:465),
 * SUMMARY_EMAIL_FROM and SUMMARY_EMAIL_TO. Without them, sending reports
 * "not configured" and nothing goes out.
 */
export function emailConfigured(): boolean {
  return smtpSettings() !== null;
}

/** The three settings, trimmed, or nothing when any one of them is missing. */
function smtpSettings(): { url: string; from: string; to: string } | null {
  const url = process.env.SMTP_URL?.trim();
  const from = process.env.SUMMARY_EMAIL_FROM?.trim();
  const to = process.env.SUMMARY_EMAIL_TO?.trim();
  return url && from && to ? { url, from, to } : null;
}

export async function sendSummaryEmail(subject: string, text: string): Promise<{ sent: boolean; reason?: string }> {
  const settings = smtpSettings();
  if (!settings) return { sent: false, reason: "SMTP_URL, SUMMARY_EMAIL_FROM or SUMMARY_EMAIL_TO is not set." };
  const transport = nodemailer.createTransport(settings.url);
  await transport.sendMail({
    from: settings.from,
    to: settings.to,
    subject,
    text,
  });
  return { sent: true };
}
