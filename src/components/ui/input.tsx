import type * as React from "react";
import { cn } from "@/lib/utils";

// DS の Input (高さ 34px、フォーカスで青枠 + 3px リング)
export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div
      className={cn(
        "flex h-[34px] items-center gap-1.5 rounded-md border border-line-strong bg-surface-card px-2.5 shadow-xs transition-control focus-within:border-line-focus focus-within:shadow-[var(--focus-ring)]",
        className,
      )}
    >
      <input
        className="min-w-0 flex-1 border-0 bg-transparent text-sm text-fg-strong outline-none placeholder:text-fg-subtle focus-visible:outline-none"
        {...props}
      />
    </div>
  );
}
