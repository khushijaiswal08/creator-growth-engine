"use client";

import { useActionState } from "react";
import { login } from "@/actions/auth";
import { FormError } from "@/components/form-error";
import { PasswordInput } from "@/components/password-input";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm({ callbackUrl }: { callbackUrl: string }) {
  const [state, action] = useActionState(login, null);

  return (
    <form action={action} className="grid gap-4">
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <div className="grid gap-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="password">Password</Label>
        <PasswordInput id="password" name="password" autoComplete="current-password" required />
        <p className="text-xs text-muted-foreground">Capital and small letters count. Click Show to check what you typed.</p>
      </div>
      <FormError state={state} />
      <SubmitButton variant="action" pendingLabel="Signing in...">
        Sign in
      </SubmitButton>
    </form>
  );
}
