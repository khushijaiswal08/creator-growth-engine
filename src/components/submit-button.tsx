"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

type Props = Omit<React.ComponentProps<typeof Button>, "type"> & {
  pendingLabel?: string;
  /** Pass when the form submits through onSubmit; otherwise the form's own status is used. */
  pending?: boolean;
};

export function SubmitButton({ children, pendingLabel, pending, disabled, ...props }: Props) {
  const status = useFormStatus();
  const busy = pending ?? status.pending;
  return (
    <Button type="submit" disabled={busy || disabled} {...props}>
      {busy && pendingLabel ? pendingLabel : children}
    </Button>
  );
}
