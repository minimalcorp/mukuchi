import type * as React from "react";
import { useId } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

type Option = { value: string; label: string };

// DS の Select はネイティブの select を装飾したもの。macOS のポップアップメニューがそのまま出る
export function Select({
  label,
  options,
  value,
  onValueChange,
  className,
  ...props
}: Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange"> & {
  label?: string;
  options: Option[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label ? (
        <label htmlFor={id} className="flex items-center gap-1 text-sm leading-[1.4] font-medium text-fg-body">
          {label}
        </label>
      ) : null}
      <div className="relative flex items-center">
        <select
          id={id}
          value={value}
          onChange={(e) => onValueChange(e.target.value)}
          className="h-[34px] w-full cursor-pointer appearance-none rounded-md border border-line-strong bg-surface-card py-0 pr-[30px] pl-2.5 text-sm text-fg-strong shadow-xs outline-none transition-control focus:border-line-focus focus:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-surface-disabled"
          {...props}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ChevronDown size={14} className="pointer-events-none absolute right-2.5 text-fg-subtle" aria-hidden />
      </div>
    </div>
  );
}
