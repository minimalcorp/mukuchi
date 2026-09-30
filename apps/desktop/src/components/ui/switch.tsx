import { Switch as SwitchPrimitive } from "radix-ui";
import { useId } from "react";
import { cn } from "@/lib/utils";

type SwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label?: string;
  "aria-label"?: string;
  disabled?: boolean;
  className?: string;
};

// スイッチ (34×20、つまみ 16px)
export function Switch({ checked, onCheckedChange, label, disabled, className, ...rest }: SwitchProps) {
  const id = useId();
  const control = (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={rest["aria-label"]}
      className={cn(
        "relative h-5 w-[34px] flex-none cursor-pointer rounded-full bg-switch-off transition-[background-color] duration-[180ms] ease-standard outline-none focus-visible:shadow-[var(--focus-ring)] data-[state=checked]:bg-action-primary disabled:cursor-not-allowed disabled:opacity-50",
        !label && className,
      )}
    >
      <SwitchPrimitive.Thumb className="absolute top-0.5 left-0.5 block size-4 rounded-full bg-gray-0 shadow-sm transition-[left] duration-[180ms] ease-out data-[state=checked]:left-4" />
    </SwitchPrimitive.Root>
  );
  if (!label) return control;
  return (
    <div className={cn("inline-flex items-center gap-2", className)}>
      {control}
      <label htmlFor={id} className="cursor-pointer text-sm leading-[1.6] text-fg-body">
        {label}
      </label>
    </div>
  );
}
