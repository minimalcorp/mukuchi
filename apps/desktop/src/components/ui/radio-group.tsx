import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

// ラジオボタンのまとまり。矢印キーでの移動・選択は Radix が扱う
export function RadioGroup({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root className={cn("flex flex-col gap-2", className)} {...props} />;
}

// ラジオボタン (16px、選択中は中央に 8px の点)
export function RadioGroupItem({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      className={cn(
        "flex size-4 flex-none cursor-pointer items-center justify-center rounded-full border border-line-strong bg-surface-card transition-control outline-none focus-visible:shadow-[var(--focus-ring)] data-[state=checked]:border-action-primary disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="size-2 rounded-full bg-action-primary" />
    </RadioGroupPrimitive.Item>
  );
}
