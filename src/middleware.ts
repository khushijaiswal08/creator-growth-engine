import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

export const { auth: middleware } = NextAuth(authConfig);

export const config = {
  // Everything except Auth.js endpoints, Next internals and static files.
  matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|icons/|chhoti/|.*\\.(?:png|jpg|svg|ico|webp)$).*)"],
};
