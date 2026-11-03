import { callApp } from "../lib/call-app.mts";

/**
 * Netlify scheduled function: every Monday morning, asks the app to send the
 * admin the weekly summary (messages, replies, gifts shipped, content posted).
 */
const run = () => callApp("weekly-summary", "/api/cron/weekly-summary");

export const config = { schedule: "0 3 * * 1" };

export default run;
