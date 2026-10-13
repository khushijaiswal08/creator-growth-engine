/**
 * Netlify scheduled function: every two minutes, asks the app to continue any
 * running discovery or AI scoring job by one slice. The jobs themselves are
 * sliced so each call finishes well inside the function time limit.
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

export const config = { schedule: "*/2 * * * *" };

export default run;
