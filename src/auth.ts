import bcrypt from "bcryptjs";
import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { authConfig } from "@/auth.config";
import { db } from "@/lib/db";
import { clearFailedAttempts, clientIp, isLockedOut, recordFailedAttempt, throttleKey } from "@/lib/login-throttle";

/** Too many failed attempts for this email from this address. */
export class RateLimitedSignin extends CredentialsSignin {
  code = "rate_limited";
}

/** The temporary password was right but is more than 24 hours old. */
export class TemporaryPasswordExpired extends CredentialsSignin {
  code = "temp_password_expired";
}

// Compared against when the email is unknown, so a miss takes as long as a wrong password.
const DUMMY_HASH = "$2b$12$bzunhXs3ZFD7b7DwMVW75etHMglWc9aLmnxeNTllW6Lp5bJtOBLsm";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: { email: {}, password: {} },
      async authorize(credentials, request) {
        const email = typeof credentials?.email === "string" ? credentials.email.trim().toLowerCase() : "";
        const password = typeof credentials?.password === "string" ? credentials.password : "";
        if (!email || !password) return null;

        const key = throttleKey(email, clientIp(request));
        if (await isLockedOut(key)) throw new RateLimitedSignin();

        const user = await db.user.findUnique({ where: { email } });
        const passwordMatches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
        if (!user || !passwordMatches) {
          await recordFailedAttempt(key);
          return null;
        }

        if (user.mustChangePassword && user.tempPasswordExpiresAt && user.tempPasswordExpiresAt < new Date()) {
          throw new TemporaryPasswordExpired();
        }

        await clearFailedAttempts(key);
        return { id: user.id, name: user.name, email: user.email };
      },
    }),
  ],
});
