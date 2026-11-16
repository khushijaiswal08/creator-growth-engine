import * as React from "react"
import { cn } from "cn"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-[42px] w-full min-w-0 rounded-xl border border-input bg-surface px-3.5 py-1 text-sm font-medium outline-none max-md:h-11 max-md:text-base transition-[color,box-shadow,border-color] selection:bg-primary-soft selection:text-foreground file:mr-3 file:inline-flex file:h-7 file:cursor-pointer file:rounded-lg file:border file:border-border file:bg-surface-2 file:px-3 file:font-semibold file:text-sm file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/20",
        "aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
