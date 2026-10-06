/**
 * What to tell someone whose sign-in failed.
 *
 * Auth.js reports every failure as an error with a `type`. Only
 * "CredentialsSignin" means the email or password was refused (its `code` says
 * why). Any other type means the check itself could not run, most often
 * because the database was asleep and did not answer in time. Telling that
 * person their password is wrong would send them off to reset a password that
 * was fine.
 */
export type SignInFailure = { type?: string; code?: string };

const REFUSED: Record<string, string> = {
  rate_limited: "Too many failed attempts. Wait 15 minutes and try again.",
  temp_password_expired: "That temporary password has expired. Ask an admin to reset it.",
};

export const COULD_NOT_CHECK =
  "The portal could not check your password just now, so nothing is wrong with what you typed. Wait a few seconds and try again.";

/** True when the email or password was looked at and refused. */
export function wasRefused(error: SignInFailure): boolean {
  return error.type === "CredentialsSignin";
}

/**
 * Says the same thing whether the email or the password was wrong, so it never confirms which
 * emails have accounts. The second sentence is the most common cause in practice: someone
 * pastes the temporary password again after they have already replaced it.
 */
export const WRONG_EMAIL_OR_PASSWORD =
  "Email or password is incorrect. If you were given a temporary password and have since chosen your own, the temporary one no longer works.";

export function signInErrorMessage(error: SignInFailure): string {
  if (!wasRefused(error)) return COULD_NOT_CHECK;
  return REFUSED[error.code ?? ""] ?? WRONG_EMAIL_OR_PASSWORD;
}
