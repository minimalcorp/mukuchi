import type * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const SIZES = {
  sm: { box: "size-6", icon: 14 },
  md: { box: "size-[30px]", icon: 16 },
} as const;

export interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: LucideIcon;
  label: string;
  size?: keyof typeof SIZES;
}

// DS の IconButton (ghost)。ラベルは aria-label と title に使う
export function IconButton({ icon: Icon, label, size = "md", className, type = "button", ...props }: IconButtonProps) {
  const s = SIZES[size];
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={cn(
        "press inline-flex items-center justify-center rounded-sm border border-transparent bg-transparent p-0 text-fg-muted transition-control enabled:hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-45",
        s.box,
        className,
      )}
      {...props}
    >
      <Icon size={s.icon} aria-hidden />
    </button>
  );
}
