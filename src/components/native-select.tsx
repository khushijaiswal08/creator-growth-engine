import { cn } from "cn";

/** A plain <select>, styled to match the inputs. Fast enough to repeat on every table row. */
export function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-9 w-full rounded-md border border-input bg-surface px-2 text-sm text-foreground outline-none",
        "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
