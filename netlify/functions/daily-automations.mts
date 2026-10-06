/**
 * Netlify scheduled function: once a day, asks the app to run its timers
 * (follow-ups due, silent creators closed, content clocks). It only calls the
 * app's own endpoint with the shared secret; the rules live in the app.
 */
const run = async () => {
  const base = (process.env.APP_URL ?? process.env.URL ?? "").replace(/\/+$/, "");
  const secret = process.env.CRON_SECRET ?? "";
  if (!base || !secret) {
    console.error("daily-automations: APP_URL (or URL) and CRON_SECRET must be set.");
    return;
  }
  const response = await fetch(`${base}/api/cron/automations`, { headers: { authorization: `Bearer ${secret}` } });
  console.log(`daily-automations: ${response.status} ${await response.text()}`);
};

export const config = { schedule: "30 2 * * *" };

export default run;
