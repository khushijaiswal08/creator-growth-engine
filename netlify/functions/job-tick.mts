import { callApp } from "../lib/call-app.mts";

/**
 * Netlify scheduled function: every ten minutes from 08:30 to 20:20 IST
 * (03:00 to 14:50 UTC), asks the app to continue any running discovery or AI
 * scoring job by one slice. The jobs themselves are sliced so each call
 * finishes well inside the function time limit. Every run costs Netlify
 * credits even when nothing is running, so it does not run at night: a job
 * left running in the evening carries on the next morning.
 */
const run = () => callApp("job-tick", "/api/cron/jobs");

export const config = { schedule: "*/10 3-14 * * *" };

export default run;
