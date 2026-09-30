import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

// ボタン。押下は 0.5px 沈み込み、ホバーは 1 段濃い色、無効は opacity .5
const buttonVariants = cva(
  "press inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium leading-[1.4] transition-control outline-none focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        primary:
          "border-action-primary bg-action-primary text-fg-inverse enabled:hover:border-action-primary-hover enabled:hover:bg-action-primary-hover enabled:active:bg-action-primary-active",
        secondary: "border-line-strong bg-surface-card text-fg-body shadow-xs enabled:hover:bg-surface-hover",
        ghost: "border-transparent bg-transparent text-fg-body enabled:hover:bg-surface-hover",
        danger:
          "border-action-danger bg-action-danger text-fg-inverse enabled:hover:border-action-danger-hover enabled:hover:bg-action-danger-hover",
      },
      size: {
        sm: "h-7 px-2.5 text-xs",
        md: "h-[34px] px-3.5 text-sm",
        lg: "h-10 px-[18px] text-md",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  iconLeft?: LucideIcon;
  iconRight?: LucideIcon;
  loading?: boolean;
}

export function Button({
  className,
  variant,
  size,
  iconLeft: IconLeft,
  iconRight: IconRight,
  loading = false,
  disabled,
  children,
  type = "button",
  ...props
}: ButtonProps) {
  const iconSize = size === "lg" ? 16 : 14;
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? (
        <LoaderCircle size={iconSize} className="animate-spin" aria-hidden />
      ) : IconLeft ? (
        <IconLeft size={iconSize} aria-hidden />
      ) : null}
      {children}
      {IconRight ? <IconRight size={iconSize} aria-hidden /> : null}
    </button>
  );
}
