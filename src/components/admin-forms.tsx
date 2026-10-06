"use client";

import type { Role, TemplatePurpose } from "@prisma/client";
import { useActionState } from "react";
import {
  addSuppression,
  archiveSampleData,
  sendWeeklySummaryNow,
  createUser,
  removeSuppression,
  resetUserPassword,
  saveTemplate,
  updateUser,
  type UserFormState,
} from "@/actions/admin";
import { FormError } from "@/components/form-error";
import { NativeSelect } from "@/components/native-select";
import { SubmitButton } from "@/components/submit-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { usePreservedForm } from "@/components/use-preserved-form";
import { BRANDS } from "@/lib/brands";
import type { FormState } from "@/lib/form";

function FormMessage({ state }: { state: FormState | UserFormState }) {
  if (!state?.message) return null;
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {state.message}
    </p>
  );
}

const PURPOSE_LABELS: Record<TemplatePurpose, string> = {
  first: "First message",
  followup: "Follow-up",
  agreed: "After they agree",
  selection: "Product selection link",
  reminder: "Content reminder",
  other: "Other",
};

export function TemplateForm({
  template,
}: {
  template?: { id: string; name: string; purpose: TemplatePurpose; body: string };
}) {
  const { state, onSubmit, pending } = usePreservedForm(saveTemplate);
  const key = template?.id ?? "new";

  return (
    <form onSubmit={onSubmit} className="grid gap-3 p-4">
      {template ? <input type="hidden" name="id" value={template.id} /> : null}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem]">
        <div className="grid gap-1.5">
          <Label htmlFor={`tpl-name-${key}`}>Name</Label>
          <Input id={`tpl-name-${key}`} name="name" required maxLength={80} defaultValue={template?.name} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`tpl-purpose-${key}`}>Used for</Label>
          <NativeSelect id={`tpl-purpose-${key}`} name="purpose" defaultValue={template?.purpose ?? "other"}>
            {(Object.keys(PURPOSE_LABELS) as TemplatePurpose[]).map((purpose) => (
              <option key={purpose} value={purpose}>
                {PURPOSE_LABELS[purpose]}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`tpl-body-${key}`}>Message</Label>
        <Textarea id={`tpl-body-${key}`} name="body" required rows={8} defaultValue={template?.body} className="text-sm" />
        <p className="text-xs text-muted-foreground">
          Placeholders filled in when messaging: {"{name} {handle} {platform} {sender} {product} {brand} {selection_link}"}
        </p>
      </div>
      <FormError state={state} />
      <div className="flex items-center justify-end gap-3">
        <FormMessage state={state} />
        <SubmitButton pending={pending} pendingLabel="Saving..." variant={template ? "default" : "action"}>
          {template ? "Save template" : "Add template"}
        </SubmitButton>
      </div>
    </form>
  );
}

export function AddSuppressionForm() {
  const [state, action] = useActionState(addSuppression, null);

  return (
    <form action={action} className="grid gap-3 p-4">
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_10rem_minmax(0,1fr)]">
        <div className="grid gap-1.5">
          <Label htmlFor="sup-email">Email</Label>
          <Input id="sup-email" name="email" type="email" placeholder="name@example.com" />
        </div>
        <p className="self-end pb-2 text-muted-foreground">or</p>
        <div className="grid gap-1.5">
          <Label htmlFor="sup-platform">Platform</Label>
          <NativeSelect id="sup-platform" name="platform" defaultValue="instagram">
            <option value="instagram">Instagram</option>
            <option value="tiktok">TikTok</option>
            <option value="youtube">YouTube</option>
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="sup-handle">Handle</Label>
          <Input id="sup-handle" name="handle" placeholder="@handle or profile URL" />
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="sup-reason">Reason</Label>
        <Input id="sup-reason" name="reason" required maxLength={300} placeholder="e.g. asked not to be contacted" />
      </div>
      <FormError state={state} />
      <div className="flex items-center justify-end gap-3">
        <FormMessage state={state} />
        <SubmitButton variant="action" pendingLabel="Adding...">
          Add to list
        </SubmitButton>
      </div>
    </form>
  );
}

export function RemoveSuppressionForm({ id, label }: { id: string; label: string }) {
  const [state, action] = useActionState(removeSuppression, null);

  return (
    <form action={action} className="grid gap-1">
      <input type="hidden" name="id" value={id} />
      <div className="flex gap-2">
        <Input
          name="reason"
          required
          maxLength={300}
          aria-label={`Reason for removing ${label}`}
          placeholder="Reason for removing"
          className="h-7 w-56 text-xs"
        />
        <SubmitButton size="xs" variant="outline" pendingLabel="Removing...">
          Remove
        </SubmitButton>
      </div>
      {state?.error ? (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/** Which brand a person works on. Admins always have both, whatever is picked here. */
function BrandChoice({ id, defaultValue, className }: { id?: string; defaultValue: string; className?: string }) {
  return (
    <NativeSelect id={id} name="brandId" defaultValue={defaultValue} className={className}>
      <option value="">Both brands</option>
      {BRANDS.map((brand) => (
        <option key={brand.id} value={brand.id}>
          {brand.name} only
        </option>
      ))}
    </NativeSelect>
  );
}

function TemporaryPassword({ state }: { state: UserFormState }) {
  if (!state?.temporaryPassword) return null;
  return (
    <div role="status" className="rounded-md border border-primary/30 bg-primary-soft px-3 py-2">
      <p>{state.message}</p>
      <p className="mt-1 font-mono text-base font-semibold select-all">{state.temporaryPassword}</p>
    </div>
  );
}

export function CreateUserForm() {
  const [state, action] = useActionState(createUser, null);

  return (
    <form action={action} className="grid gap-3 p-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem_14rem]">
        <div className="grid gap-1.5">
          <Label htmlFor="new-user-name">Name</Label>
          <Input id="new-user-name" name="name" required maxLength={80} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="new-user-email">Email</Label>
          <Input id="new-user-email" name="email" type="email" required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="new-user-role">Role</Label>
          <NativeSelect id="new-user-role" name="role" defaultValue="marketer">
            <option value="marketer">Marketer</option>
            <option value="admin">Admin</option>
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="new-user-brand">Works on</Label>
          <BrandChoice id="new-user-brand" defaultValue="" />
        </div>
      </div>
      <p className="text-muted-foreground">
        Someone who works on one brand sees and changes only that brand&apos;s campaigns, creators and gift orders. Admins always see both.
      </p>
      <FormError state={state} />
      <TemporaryPassword state={state} />
      <div className="flex justify-end">
        <SubmitButton variant="action" pendingLabel="Creating...">
          Create user
        </SubmitButton>
      </div>
    </form>
  );
}

export function UserRow({
  user,
  temporaryPassword,
  isSelf,
}: {
  user: { id: string; name: string; email: string; role: Role; brandId: string | null };
  /** Shown beside the row when the user still holds a temporary password. */
  temporaryPassword: string | null;
  isSelf: boolean;
}) {
  const edit = usePreservedForm(updateUser);
  const [resetState, resetAction] = useActionState(resetUserPassword, null);

  return (
    <li className="grid gap-2 px-4 py-3">
      <div className="flex flex-wrap items-end gap-2">
        <form onSubmit={edit.onSubmit} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="id" value={user.id} />
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            Name
            <Input name="name" required maxLength={80} defaultValue={user.name} className="h-8 w-48 text-sm text-foreground" />
          </label>
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            Email
            <Input name="email" type="email" required defaultValue={user.email} className="h-8 w-64 text-sm text-foreground" />
          </label>
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            Role
            <NativeSelect name="role" defaultValue={user.role} className="h-8 w-32 text-foreground">
              <option value="marketer">Marketer</option>
              <option value="admin">Admin</option>
            </NativeSelect>
          </label>
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            Works on
            {/* The key resets the select when a save turns the stored value back (an admin always has both). */}
            <BrandChoice key={user.brandId ?? "both"} defaultValue={user.brandId ?? ""} className="h-8 w-52 text-foreground" />
          </label>
          <SubmitButton size="sm" variant="outline" pending={edit.pending} pendingLabel="Saving...">
            Save
          </SubmitButton>
        </form>
        {isSelf ? (
          <span className="pb-1.5 text-muted-foreground">This is you</span>
        ) : (
          <form action={resetAction}>
            <input type="hidden" name="id" value={user.id} />
            <SubmitButton size="sm" variant="outline" pendingLabel="Resetting...">
              Reset password
            </SubmitButton>
          </form>
        )}
        {temporaryPassword ? <span className="pb-1.5 text-muted-foreground">{temporaryPassword}</span> : null}
      </div>
      <FormError state={edit.state} />
      <FormMessage state={edit.state} />
      <FormError state={resetState} />
      <TemporaryPassword state={resetState} />
    </li>
  );
}

export function ArchiveSampleButton({ remaining }: { remaining: number }) {
  const [state, action] = useActionState(archiveSampleData, null);

  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <SubmitButton variant="outline" disabled={remaining === 0} pendingLabel="Archiving...">
        Archive all sample data
      </SubmitButton>
      <FormError state={state} />
      <FormMessage state={state} />
    </form>
  );
}

export function SendSummaryButton({ configured }: { configured: boolean }) {
  const [state, action] = useActionState(sendWeeklySummaryNow, null);

  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <SubmitButton variant="outline" disabled={!configured} pendingLabel="Sending...">
        Send last week&apos;s summary now
      </SubmitButton>
      <FormError state={state} />
      <FormMessage state={state} />
    </form>
  );
}
