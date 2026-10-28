import { cn } from "cn";

/** A plain <select>, styled to match the inputs. Fast enough to repeat on every table row. */
export function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-[42px] w-full rounded-xl border border-input bg-surface px-3 text-sm font-medium text-foreground outline-none transition-[box-shadow,border-color] max-md:h-11 max-md:text-base",
        "focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/20",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
