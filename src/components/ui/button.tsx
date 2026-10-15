import { Slot } from "radix-ui";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline" | "on" | "off";
type Size = "sm" | "md" | "lg" | "icon";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent text-ink-950 hover:bg-accent-strong shadow-[0_0_0_1px_rgb(56_217_245/0.4),0_8px_30px_-10px_rgb(56_217_245/0.6)] font-semibold",
  secondary: "bg-ink-700 text-ink-100 hover:bg-ink-600 border border-ink-600",
  outline: "border border-ink-500 text-ink-100 hover:border-accent/60 hover:text-white bg-transparent",
  ghost: "text-ink-200 hover:bg-ink-700/70 hover:text-white",
  danger: "bg-danger/15 text-danger border border-danger/50 hover:bg-danger/25",
  on: "bg-gradient-to-b from-[#ffe2b8] to-warm text-ink-950 font-semibold shadow-[0_0_0_1px_rgb(255_207_153/0.6),0_10px_40px_-12px_rgb(255_207_153/0.8)] hover:brightness-105",
  off: "bg-ink-750 text-ink-100 border border-ink-500 hover:border-ink-300 font-semibold",
};

const sizes: Record<Size, string> = {
  sm: "h-8 px-3 text-xs gap-1.5 rounded-lg",
  md: "h-10 px-4 text-sm gap-2 rounded-xl",
  lg: "h-14 px-6 text-base gap-2.5 rounded-2xl",
  icon: "h-10 w-10 rounded-xl",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "secondary", size = "md", asChild, type, ...props },
  ref,
) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : (type ?? "button")}
      className={cn(
        "inline-flex select-none items-center justify-center whitespace-nowrap transition-[background-color,border-color,color,box-shadow,filter,transform] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
});
