/**
 * Netlify scheduled function: every Monday morning, asks the app to send the
 * admin the weekly summary (messages, replies, gifts shipped, content posted).
 */
const run = async () => {
  const base = (process.env.APP_URL ?? process.env.URL ?? "").replace(/\/+$/, "");
  const secret = process.env.CRON_SECRET ?? "";
  if (!base || !secret) {
    console.error("weekly-summary: APP_URL (or URL) and CRON_SECRET must be set.");
    return;
  }
  const response = await fetch(`${base}/api/cron/weekly-summary`, { headers: { authorization: `Bearer ${secret}` } });
  console.log(`weekly-summary: ${response.status} ${await response.text()}`);
};

export const config = { schedule: "0 3 * * 1" };

export default run;
