import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  const { callbackUrl } = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm card p-7">
        <h1 className="text-2xl">Creator Growth Engine</h1>
        <p className="mt-1 mb-5 text-muted-foreground">Sign in with your team account.</p>
        <LoginForm callbackUrl={callbackUrl ?? ""} />
      </div>
    </main>
  );
}
