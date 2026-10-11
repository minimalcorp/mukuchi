import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import type { GpuStatus } from "@/lib/ipc";
import { useI18n } from "@/i18n/context";

/**
 * GPU を使えない時の注意 (CPU では遅いこと) と、ドライバーの更新・再検出の案内 (Windows のみ)。
 * セットアップの差し込み画面と設定の「認識」で共通。action は案内の行の右に置く操作 (再検出)
 */
export function GpuNotice({ gpu, action }: { gpu: GpuStatus; action?: ReactNode }) {
  const { t } = useI18n();
  const g = t.gpu;
  return (
    <>
      <div
        data-testid="gpu-cpu-warning"
        className="flex items-start gap-2.5 rounded-md bg-tone-warning-bg px-3 py-2.5 text-xs text-tone-warning-fg"
      >
        <TriangleAlert size={16} className="mt-px flex-none" aria-hidden />
        <span className="flex-1 leading-[1.5]">{g.cpuWarning}</span>
      </div>
      <div className="flex items-center gap-2.5 rounded-md bg-surface-muted px-3 py-2.5 text-xs text-fg-body">
        <span className="flex-1 leading-[1.5]">{gpu.kind === "driver_missing" ? g.driverHint : g.noneHint}</span>
        {action}
      </div>
    </>
  );
}
