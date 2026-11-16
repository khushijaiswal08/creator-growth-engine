import { cn } from "cn";

export function initials(name: string): string {
  const parts = name.trim().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  // Whole characters, not UTF-16 halves: styled names (𝓐𝓷𝓷𝓪, 𝐀𝐧𝐧𝐚) use letters outside the basic range, and
  // cutting one in half shows a broken glyph that differs between server and browser (React error 418).
  const first = Array.from(parts[0]);
  const last = Array.from(parts[parts.length - 1]);
  return ((first[0] ?? "") + (parts.length > 1 ? (last[0] ?? "") : (first[1] ?? ""))).toUpperCase();
}

// Five soft tints, chosen by the name, so a list of people is easy to scan. Each text colour clears 4.5:1 on its tint.
const TINTS = ["bg-primary-soft text-primary-text", "bg-info-soft text-info-text", "bg-success-soft text-success-text", "bg-warning-soft text-warning-text", "bg-violet-soft text-violet-text"];

function tintFor(name: string): string {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return TINTS[hash % TINTS.length];
}

/** A soft circle with the person's initials. Decorative: the name is always next to it. */
export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("flex size-[38px] shrink-0 items-center justify-center rounded-full text-[12.5px] font-extrabold", tintFor(name), className)}
    >
      {initials(name)}
    </span>
  );
}
