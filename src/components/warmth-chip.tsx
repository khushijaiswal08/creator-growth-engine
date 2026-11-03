import { cn } from "cn";
import { Flame } from "lucide-react";
import { WARMTH_LABELS, type Warmth } from "@/lib/reply-reader";
import { TONE_CLASSES } from "@/lib/status";

const WARMTH_CLASSES: Record<Warmth, string> = { hot: TONE_CLASSES.danger, warm: TONE_CLASSES.warning, cold: TONE_CLASSES.neutral };

/** Hot, warm or cold, as Rachna read the latest reply. Red with a flame, amber, or grey. */
export function WarmthChip({ warmth, title, className }: { warmth: Warmth; title?: string; className?: string }) {
  return (
    <span title={title} className={cn("chip border-transparent", WARMTH_CLASSES[warmth], className)}>
      {warmth === "hot" ? <Flame className="size-3" strokeWidth={2.5} /> : null}
      {WARMTH_LABELS[warmth]}
    </span>
  );
}
