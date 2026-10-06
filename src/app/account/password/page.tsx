import type { Metadata } from "next";
import Link from "next/link";
import { requireUserForPasswordChange } from "@/lib/session";
import { PasswordForm } from "./password-form";

export const metadata: Metadata = { title: "Change password" };

export default async function PasswordPage() {
  const user = await requireUserForPasswordChange();

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm card p-7">
        <h1 className="text-2xl">Change password</h1>
        <p className="mt-1 mb-5 text-muted-foreground">
          {user.mustChangePassword
            ? `${user.name}, you signed in with a temporary password. Choose your own before continuing.`
            : `Signed in as ${user.email}.`}
        </p>
        <PasswordForm />
        {user.mustChangePassword ? null : (
          <p className="mt-4 text-center">
            <Link href="/today" className="link">
              Cancel
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}
