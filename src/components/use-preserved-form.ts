"use client";

import { startTransition, useActionState } from "react";
import type { FormState } from "@/lib/form";

/**
 * useActionState for longer forms. Submitting through <form action> resets
 * every field when the action returns, which throws away what the person
 * typed if validation fails; dispatching from onSubmit keeps it.
 */
export function usePreservedForm(action: (prev: FormState, formData: FormData) => Promise<FormState>) {
  const [state, dispatch, pending] = useActionState(action, null);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatch(formData));
  }

  return { state, onSubmit, pending };
}
