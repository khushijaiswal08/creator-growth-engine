import { cookies } from "next/headers";
import { signOut } from "@/auth";

/**
 * Signing out is a plain page request, not a Server Action: the browser posts the Sign out form here,
 * the session cookie is deleted, and the browser follows an ordinary redirect to /login.
 *
 * It used to be a Server Action that called signOut({ redirectTo: "/login" }). On the live site
 * (Netlify, 2026-11-12) that left the person signed in: the action's redirect to /login met the
 * middleware, which sent a still-signed-in person back to /today, and the page crashed with
 * "An unexpected response was received from the server". Nobody could switch accounts.
 */
async function endSession(): Promise<void> {
  await signOut({ redirect: false });
  // Belt and braces: expire every Auth.js session cookie by name, whichever form it took (secure or
  // not, and the numbered chunks of a large session). A "__Secure-" cookie is only replaced by a
  // Set-Cookie that is itself Secure; a plain delete is ignored by the browser.
  const jar = await cookies();
  for (const { name } of jar.getAll()) {
    if (!/^(__Secure-)?authjs\.session-token(\.\d+)?$/.test(name)) continue;
    jar.set(name, "", { path: "/", expires: new Date(0), maxAge: 0, httpOnly: true, sameSite: "lax", secure: name.startsWith("__Secure-") });
  }
}

/** The account menu's Sign out button (a form post). Only a page of this portal may ask. */
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return new Response("Forbidden", { status: 403 });
  await endSession();
  // A relative address on purpose: the browser stays on the host it used to reach the portal.
  return new Response(null, { status: 303, headers: { Location: "/login", "Cache-Control": "no-store" } });
}

// requireUser() sends people here when their session points at a user that no longer exists.
export async function GET() {
  await endSession();
  return new Response(null, { status: 307, headers: { Location: "/login", "Cache-Control": "no-store" } });
}
