"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";

/**
 * A password box with a Show button, so a typing slip is seen before it turns
 * into "wrong password" or, when choosing a new one, into a password nobody
 * knows.
 */
export function PasswordInput(props: Omit<React.ComponentProps<typeof Input>, "type">) {
  const [shown, setShown] = useState(false);

  return (
    <div className="relative">
      <Input {...props} type={shown ? "text" : "password"} className="pr-[4.75rem]" />
      <button
        type="button"
        onClick={() => setShown((current) => !current)}
        aria-pressed={shown}
        aria-label={shown ? "Hide password" : "Show password"}
        className="absolute inset-y-0 right-0 flex items-center gap-1 rounded-r-md px-2.5 text-xs font-medium text-accent-text outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        {shown ? <EyeOff aria-hidden className="size-4" /> : <Eye aria-hidden className="size-4" />}
        {shown ? "Hide" : "Show"}
      </button>
    </div>
  );
}
