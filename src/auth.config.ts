import type { NextAuthConfig } from "next-auth";

// Pages anyone may open without signing in.
const PUBLIC_PATHS = new Set(["/privacy", "/terms", "/health"]);

// Served over HTTPS (always true on Netlify and Vercel): the session cookie must then never travel over plain HTTP.
const secure =
  process.env.NETLIFY === "true" ||
  process.env.VERCEL === "1" ||
  (process.env.AUTH_URL ?? "").startsWith("https://") ||
  (process.env.APP_URL ?? "").startsWith("https://");

/**
 * Edge-safe half of the Auth.js config: no database or bcrypt imports, so the
 * middleware can use it. The credentials provider is added in auth.ts.
 */
export const authConfig = {
  pages: { signIn: "/login" },
  session: { strategy: "jwt", maxAge: 7 * 24 * 60 * 60 },
  useSecureCookies: secure,
  cookies: {
    sessionToken: {
      name: secure ? "__Secure-authjs.session-token" : "authjs.session-token",
      // httpOnly keeps the cookie away from page scripts; secure keeps it off plain HTTP.
      options: { httpOnly: true, sameSite: "lax", path: "/", secure },
    },
  },
  providers: [],
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = Boolean(auth?.user);
      if (PUBLIC_PATHS.has(nextUrl.pathname)) return true;
      // The creator's product-selection page (guarded by its own token) and the scheduler endpoint (guarded by CRON_SECRET).
      if (nextUrl.pathname.startsWith("/select/") || nextUrl.pathname.startsWith("/api/cron/")) return true;
      if (nextUrl.pathname === "/login") {
        if (isLoggedIn) return Response.redirect(new URL("/today", nextUrl));
        return true;
      }
      return isLoggedIn;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
} satisfies NextAuthConfig;
