import type * as React from "react";
import { cn } from "@/lib/utils";

// 複数行のテキスト入力 (Input と同じ枠・フォーカスの青枠 + 3px リング)
export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "block w-full resize-y rounded-md border border-line-strong bg-surface-card px-2.5 py-2 text-sm leading-[1.6] text-fg-strong shadow-xs transition-control outline-none placeholder:text-fg-subtle focus:border-line-focus focus:shadow-[var(--focus-ring)] focus-visible:outline-none",
        className,
      )}
      {...props}
    />
  );
}
