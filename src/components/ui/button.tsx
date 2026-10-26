import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-transparent text-sm font-semibold cursor-pointer transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-px disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-[#f0c573]/70 bg-gradient-to-b from-[#f2c56f] to-[#d7a043] text-[#231406] shadow-[inset_0_1px_0_rgba(255,246,200,.35),0_2px_8px_rgba(0,0,0,.24)] hover:from-[#f8d592] hover:to-[#e6ad4d]",
        destructive: "border-red-400/40 bg-gradient-to-b from-[#c63c43] to-[#8b2029] text-white shadow-sm hover:brightness-110",
        outline:
          "border border-gold/25 bg-[#100c0a] text-[#e5d7c5] shadow-sm hover:border-gold/60 hover:bg-gold/10 hover:text-gold",
        secondary: "border border-gold/15 bg-secondary text-secondary-foreground shadow-sm hover:border-gold/35 hover:bg-[#382719]",
        ghost: "text-muted-foreground hover:bg-gold/10 hover:text-gold",
        link: "text-gold underline-offset-4 hover:underline",
      },
      size: {
        default: "min-h-10 px-4 py-2",
        sm: "min-h-9 rounded-lg px-3 py-1.5 text-xs",
        lg: "min-h-11 rounded-lg px-7 py-2.5",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
