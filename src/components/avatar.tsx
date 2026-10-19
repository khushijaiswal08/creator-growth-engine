import { cn } from "cn";

function initials(name: string): string {
  const parts = name.trim().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return ((parts[0][0] ?? "") + (parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : (parts[0][1] ?? ""))).toUpperCase();
}

/** A small rose circle with the person's initials. Decorative: the name is always next to it. */
export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-[12px] font-bold text-primary-text",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
