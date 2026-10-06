"use client";

import { useActionState } from "react";
import { changePassword } from "@/actions/account";
import { FormError } from "@/components/form-error";
import { PasswordInput } from "@/components/password-input";
import { SubmitButton } from "@/components/submit-button";
import { Label } from "@/components/ui/label";

export function PasswordForm() {
  const [state, action] = useActionState(changePassword, null);

  return (
    <form action={action} className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="current">Current password</Label>
        <PasswordInput id="current" name="current" autoComplete="current-password" required autoFocus />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="next">New password</Label>
        <PasswordInput id="next" name="next" autoComplete="new-password" required minLength={10} />
        <p className="text-xs text-muted-foreground">At least 10 characters. Click Show to see exactly what you are choosing.</p>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="confirm">New password again</Label>
        <PasswordInput id="confirm" name="confirm" autoComplete="new-password" required minLength={10} />
      </div>
      <p className="rounded-md bg-warning-soft px-3 py-2 text-warning-text">
        From now on you sign in with this new password. The one you used until now stops working, and nobody can look the new one up
        for you, so keep it somewhere safe before you click.
      </p>
      <FormError state={state} />
      <SubmitButton variant="action" pendingLabel="Saving...">
        Change password
      </SubmitButton>
    </form>
  );
}
