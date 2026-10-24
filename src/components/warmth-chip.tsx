import { cn } from "cn";
import { Flame } from "lucide-react";
import { WARMTH_LABELS, type Warmth } from "@/lib/reply-reader";

/** Hot, warm or cold, as Rachna read the latest reply. Red with a flame, amber, or grey. */
export function WarmthChip({ warmth, title, className }: { warmth: Warmth; title?: string; className?: string }) {
  return (
    <span title={title} className={cn("chip border-transparent", warmth === "hot" ? "bg-danger-soft text-danger-text" : warmth === "warm" ? "bg-warning-soft text-warning-text" : "bg-surface-2 text-accent-text", className)}>
      {warmth === "hot" ? <Flame className="size-3" strokeWidth={2.5} /> : null}
      {WARMTH_LABELS[warmth]}
    </span>
  );
}
