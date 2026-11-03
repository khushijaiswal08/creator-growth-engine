import { callApp } from "../lib/call-app.mts";

/**
 * Netlify scheduled function: once a day, asks the app to run its timers
 * (follow-ups due, silent creators closed, content clocks) and to settle
 * uploads nobody reported. It only calls the app's own endpoint with the
 * shared secret; the rules live in the app.
 */
const run = () => callApp("daily-automations", "/api/cron/automations");

export const config = { schedule: "30 2 * * *" };

export default run;
