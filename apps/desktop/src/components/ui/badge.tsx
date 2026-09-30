import type * as React from "react";
import { cn } from "@/lib/utils";

export type BadgeTone = "neutral" | "info" | "primary" | "success" | "warning" | "danger" | "violet";

const TONES: Record<BadgeTone, string> = {
  neutral: "bg-tone-neutral-bg text-tone-neutral-fg",
  info: "bg-tone-info-bg text-tone-info-fg",
  primary: "bg-tone-primary-bg text-tone-primary-fg",
  success: "bg-tone-success-bg text-tone-success-fg",
  warning: "bg-tone-warning-bg text-tone-warning-fg",
  danger: "bg-tone-danger-bg text-tone-danger-fg",
  violet: "bg-tone-violet-bg text-tone-violet-fg",
};

export function Badge({
  tone = "neutral",
  dot = false,
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone; dot?: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-medium leading-[1.4]",
        TONES[tone],
        className,
      )}
      {...props}
    >
      {dot ? <span className="size-1.5 flex-none rounded-full bg-current" aria-hidden /> : null}
      {children}
    </span>
  );
}
