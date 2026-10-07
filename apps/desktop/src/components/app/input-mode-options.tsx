import { useId } from "react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { INPUT_MODE_IDS } from "@/lib/input-mode";
import { useI18n } from "@/i18n/context";
import type { InputMode } from "@/lib/ipc";
import { cn } from "@/lib/utils";

/** 入力モードの選択 (枠付きのカード)。選んだらすぐ保存する前提で、確定のボタンは持たない */
export function InputModeRadio({
  value,
  onChange,
  disabled,
  className,
}: {
  value: InputMode | undefined;
  onChange: (mode: InputMode) => void;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const { t } = useI18n();
  return (
    <RadioGroup
      aria-label={t.inputMode.groupLabel}
      // 読み込み前 (undefined) も制御された値として渡す (uncontrolled から切り替わると Radix が警告するため)
      value={value ?? ""}
      disabled={disabled}
      onValueChange={(v) => onChange(v as InputMode)}
      className={className}
    >
      {INPUT_MODE_IDS.map((mode) => ({ id: mode, ...t.inputMode[mode] })).map((m) => (
        <label
          key={m.id}
          data-testid={`input-mode-${m.id}`}
          className={cn(
            "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3.5 py-2.5 transition-control",
            value === m.id ? "border-action-primary bg-surface-selected" : "border-line-default bg-surface-card",
          )}
        >
          <RadioGroupItem
            value={m.id}
            className="mt-0.5"
            aria-labelledby={`${id}-${m.id}-label`}
            aria-describedby={`${id}-${m.id}-desc`}
          />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span id={`${id}-${m.id}-label`} className="text-sm leading-[1.4] font-medium text-fg-strong">
              {m.label}
            </span>
            <span id={`${id}-${m.id}-desc`} className="text-xs leading-[1.5] text-fg-muted">
              {m.description}
            </span>
          </span>
        </label>
      ))}
    </RadioGroup>
  );
}
