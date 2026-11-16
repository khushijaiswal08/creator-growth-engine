import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  // Everything except Auth.js endpoints, the scheduler endpoints (each checks CRON_SECRET itself, and
  // skipping the middleware saves a billed edge request per call), the test copy's signed file
  // addresses (large uploads must not pass through it), /logout (the middleware re-issues the session
  // cookie on every request it sees, and on Netlify that re-issue outlived the sign-out's deletion, so
  // nobody could sign out), Next internals and static files.
  matcher: ["/((?!api/auth|api/cron|api/content-store|logout|_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|icons/|rachna/|.*\\.(?:png|jpg|svg|ico|webp)$).*)"],
};
