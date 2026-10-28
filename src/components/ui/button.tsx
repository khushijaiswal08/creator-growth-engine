import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

// Rounded, bold, and they answer back: a lift on hover, a press on click. One rose "action" button per screen;
// everything else is white and outlined, a soft rose tint, or quiet.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-xl text-sm font-bold whitespace-nowrap transition-all duration-150 outline-none active:scale-[0.98] focus-visible:ring-[3px] focus-visible:ring-ring/35 disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Secondary: the everyday button.
        default: "border border-border-strong bg-surface text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.05)] hover:bg-[#f8fafc]",
        outline: "border border-border-strong bg-surface text-foreground shadow-[0_1px_2px_rgba(15,23,42,0.05)] hover:bg-[#f8fafc]",
        // Primary: the theme colour, for the single main action on a screen.
        action: "bg-primary text-on-primary shadow-[0_1px_2px_rgba(15,23,42,0.08),0_6px_14px_rgba(178,74,107,0.28)] hover:-translate-y-px hover:bg-primary-deep",
        // A softer rose, for a second positive action beside the main one.
        soft: "bg-primary-faint text-primary hover:bg-primary-soft",
        secondary: "bg-surface-2 text-foreground hover:bg-border",
        // Quiet: no border.
        ghost: "text-accent-text hover:bg-surface-2 hover:text-foreground",
        destructive: "border border-danger-soft bg-surface text-danger-text hover:bg-danger-soft",
        link: "text-primary underline-offset-4 hover:underline active:scale-100",
      },
      size: {
        default: "h-[42px] px-[18px] has-[>svg]:px-4 max-md:h-11",
        xs: "h-[30px] gap-1.5 rounded-[9px] px-[11px] text-[12.5px] has-[>svg]:px-2.5 [&_svg:not([class*='size-'])]:size-3.5 max-md:h-9 max-md:px-3 max-md:text-sm",
        sm: "h-9 gap-1.5 rounded-[10px] px-3.5 text-[13px] has-[>svg]:px-3 max-md:h-10",
        lg: "h-11 px-6 has-[>svg]:px-5",
        icon: "size-[42px]",
        "icon-xs": "size-[30px] rounded-[9px] [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-9 rounded-[10px]",
        "icon-lg": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
