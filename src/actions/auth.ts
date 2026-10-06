"use server";

import { AuthError } from "next-auth";
import { signIn, signOut } from "@/auth";
import { field, type FormState } from "@/lib/form";
import { signInErrorMessage, wasRefused } from "@/lib/sign-in-errors";

export async function login(_prev: FormState, formData: FormData): Promise<FormState> {
  const password = formData.get("password");
  const attempt = () =>
    signIn("credentials", {
      email: field(formData, "email"),
      password: typeof password === "string" ? password : "",
      // Auth.js only follows same-origin redirects.
      redirectTo: field(formData, "callbackUrl") || "/today",
    });

  try {
    try {
      await attempt();
    } catch (error) {
      // The database sleeps when nobody has used the portal for a while and can miss its
      // first connection. When the check could not run at all, try once more a moment later.
      if (!(error instanceof AuthError) || wasRefused(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await attempt();
    }
  } catch (error) {
    if (error instanceof AuthError) {
      if (!wasRefused(error)) console.error("Sign-in could not be checked", error.cause ?? error);
      return { error: signInErrorMessage(error) };
    }
    throw error;
  }
  return null;
}

export async function logout() {
  await signOut({ redirectTo: "/login" });
}
