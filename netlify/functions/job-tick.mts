/**
 * Netlify scheduled function: every ten minutes from 08:30 to 20:20 IST
 * (03:00 to 14:50 UTC), asks the app to continue any running discovery or AI
 * scoring job by one slice. The jobs themselves are sliced so each call
 * finishes well inside the function time limit. Every run costs Netlify
 * credits even when nothing is running, so it does not run at night: a job
 * left running in the evening carries on the next morning.
 */
const run = async () => {
  const base = (process.env.APP_URL ?? process.env.URL ?? "").replace(/\/+$/, "");
  const secret = process.env.CRON_SECRET ?? "";
  if (!base || !secret) {
    console.error("job-tick: APP_URL (or URL) and CRON_SECRET must be set.");
    return;
  }
  const response = await fetch(`${base}/api/cron/jobs`, { headers: { authorization: `Bearer ${secret}` } });
  console.log(`job-tick: ${response.status} ${await response.text()}`);
};

export const config = { schedule: "*/10 3-14 * * *" };

export default run;
