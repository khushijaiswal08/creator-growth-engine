import nodemailer from "nodemailer";

/**
 * Outgoing email for the weekly summary only. Never used to write to creators.
 * Configured with SMTP_URL (for example smtps://user:app-password@smtp.gmail.com:465),
 * SUMMARY_EMAIL_FROM and SUMMARY_EMAIL_TO. Without them, sending reports
 * "not configured" and nothing goes out.
 */
export function emailConfigured(): boolean {
  return Boolean(process.env.SMTP_URL?.trim() && process.env.SUMMARY_EMAIL_FROM?.trim() && process.env.SUMMARY_EMAIL_TO?.trim());
}

export async function sendSummaryEmail(subject: string, text: string): Promise<{ sent: boolean; reason?: string }> {
  if (!emailConfigured()) return { sent: false, reason: "SMTP_URL, SUMMARY_EMAIL_FROM or SUMMARY_EMAIL_TO is not set." };
  const transport = nodemailer.createTransport(process.env.SMTP_URL!.trim());
  await transport.sendMail({
    from: process.env.SUMMARY_EMAIL_FROM!.trim(),
    to: process.env.SUMMARY_EMAIL_TO!.trim(),
    subject,
    text,
  });
  return { sent: true };
}
