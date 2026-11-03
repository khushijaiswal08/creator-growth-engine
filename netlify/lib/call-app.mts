/**
 * Calls one of the app's /api/cron endpoints with the shared secret and logs
 * the reply. The rules live in the app; these functions only ring the bell.
 */
export async function callApp(name: string, path: string): Promise<void> {
  const base = (process.env.APP_URL ?? process.env.URL ?? "").replace(/\/+$/, "");
  const secret = process.env.CRON_SECRET ?? "";
  if (!base || !secret) {
    console.error(`${name}: APP_URL (or URL) and CRON_SECRET must be set.`);
    return;
  }
  const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${secret}` } });
  console.log(`${name}: ${response.status} ${await response.text()}`);
}
