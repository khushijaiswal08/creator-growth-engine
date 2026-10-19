"use client";

import { NativeSelect } from "@/components/native-select";

/** A select that submits its form the moment a choice is made, so a filter needs no button. */
export function AutoSubmitSelect(props: React.ComponentProps<"select">) {
  return <NativeSelect {...props} onChange={(event) => event.currentTarget.form?.requestSubmit()} />;
}
