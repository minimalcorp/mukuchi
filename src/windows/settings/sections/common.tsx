import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import type { Settings } from "@/lib/ipc";
import type { SettingsErrors } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { HelpTip } from "@/components/ui/tooltip";

export type SectionProps = {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  /** 保存に失敗した設定キーとメッセージ */
  errors: SettingsErrors;
};

/** 操作の近くに出すエラー (保存の失敗・入力の検証) */
export function FieldError({ message, className }: { message: string | null | undefined; className?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className={cn("m-0 flex items-start gap-1.5 text-xs leading-[1.5] text-fg-danger", className)}>
      <CircleAlert size={14} className="mt-px flex-none" aria-hidden />
      <span>{message}</span>
    </p>
  );
}

/** 枠付きのまとまり (デザインの border 1px・角丸 8px のカード) */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex flex-col rounded-lg border border-line-default", className)}>{children}</div>;
}

/** カード内の行。最後の行以外に区切り線を引く */
export function Row({ last = false, className, children }: { last?: boolean; className?: string; children: ReactNode }) {
  return (
    <div className={cn("flex items-center gap-3 px-3.5 py-3", !last && "border-b border-line-subtle", className)}>
      {children}
    </div>
  );
}

/** 「発話検出の感度 (?) ……… 60」のような見出し行 */
export function FieldHeading({ label, help, value }: { label: string; help?: string; value?: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-sm leading-[1.4] font-medium">
      {label}
      {help ? <HelpTip content={help} /> : null}
      <span className="flex-1" />
      {value != null ? <span className="tabular text-xs font-normal text-fg-muted">{value}</span> : null}
    </div>
  );
}

export function TitleWithSub({ title, sub }: { title: ReactNode; sub: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-sm leading-[1.4] font-medium">{title}</span>
      <span className="text-xs leading-[1.4] text-fg-muted">{sub}</span>
    </div>
  );
}
