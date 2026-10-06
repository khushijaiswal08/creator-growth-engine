import { signOut } from "@/auth";

// Clears the session cookie. requireUser() sends people here when their
// session points at a user that no longer exists.
export async function GET() {
  await signOut({ redirect: false });
  // A relative address on purpose: the browser stays on the host it used to reach the portal.
  // Building it from the request's own URL can name a different host behind a proxy or in development.
  return new Response(null, { status: 307, headers: { Location: "/login" } });
}
