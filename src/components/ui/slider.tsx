import type * as React from "react";
import { cn } from "@/lib/utils";

// デザインはネイティブの range + accent-color。macOS の見た目に揃う
export function Slider({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input type="range" className={cn("w-full accent-[var(--blue-500)]", className)} {...props} />;
}
