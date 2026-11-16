"use client";

import { cn } from "cn";
import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { THEME_KEY, type ThemeChoice } from "@/lib/theme";

function readChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "dark" || value === "device" ? value : "light";
  } catch {
    return "light";
  }
}

function apply(choice: ThemeChoice) {
  const dark = choice === "dark" || (choice === "device" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

const OPTIONS: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "device", label: "Device", icon: Monitor },
];

/** Light, Dark or Device: three segments in the menu under the person's name. Remembered on this browser. */
export function ThemeSwitch() {
  const [choice, setChoice] = useState<ThemeChoice>("light");

  useEffect(() => {
    setChoice(readChoice());
  }, []);

  // With "Device", follow the computer when it switches between day and night.
  useEffect(() => {
    if (choice !== "device") return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const follow = () => apply("device");
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, [choice]);

  function choose(next: ThemeChoice) {
    setChoice(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private windows may refuse storage: the theme still changes for this visit.
    }
    apply(next);
  }

  return (
    <div className="px-3 py-2">
      <p className="label mb-1.5">Theme</p>
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-1 rounded-lg bg-surface-2 p-1">
        {OPTIONS.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={choice === value}
            onClick={() => choose(value)}
            className={cn(
              "flex h-8 items-center justify-center gap-1.5 rounded-md text-xs font-bold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              choice === value ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" strokeWidth={2} aria-hidden />
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
