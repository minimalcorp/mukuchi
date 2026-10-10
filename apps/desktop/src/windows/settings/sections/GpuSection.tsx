import { useState } from "react";
import { Cpu, Gpu, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { GpuNotice } from "@/components/app/gpu-notice";
import { needsCpuConsent } from "@/lib/hooks";
import { gpuDeviceView } from "@/lib/gpu";
import type { GpuStatus } from "@/lib/ipc";
import { useI18n } from "@/i18n/context";
import { Card, ConfirmLayout, FieldError, FieldHeading, TitleWithSub, type SectionProps } from "./common";

/**
 * 使用中のデバイスと再検出、GPU を使えない時の CPU 実行の同意 (Windows のみ。設定の「認識」)。
 * 同意は注意書きを読んでから確認のダイアログで行う (gpu_unavailable の「CPU で続ける」もここを開く)
 */
export function GpuSection({
  settings,
  update,
  errors,
  gpu,
  gpuError,
  probing,
  onProbe,
}: SectionProps & { gpu: GpuStatus | null; gpuError: string | null; probing: boolean; onProbe: () => void }) {
  const { t } = useI18n();
  const g = t.gpu;
  const [confirm, setConfirm] = useState(false);
  const consent = needsCpuConsent(gpu, settings);
  const view = gpu ? gpuDeviceView(gpu, t) : null;
  const Icon = view?.device === "cpu" ? Cpu : Gpu;
  return (
    <div data-testid="gpu-section" className="flex flex-col gap-2">
      <FieldHeading label={g.heading} help={g.help} />
      <Card>
        <div className="flex items-center gap-3 px-3.5 py-3">
          <Icon size={20} className="flex-none text-fg-muted" aria-hidden />
          <TitleWithSub title={view?.title ?? g.checking} sub={view?.sub ?? " "} />
          <Button size="sm" iconLeft={RefreshCw} loading={probing} disabled={!gpu} onClick={onProbe}>
            {g.detect}
          </Button>
        </div>
        {consent && gpu ? (
          <div data-testid="gpu-consent" className="flex flex-col gap-2.5 border-t border-line-subtle px-3.5 py-3">
            <GpuNotice gpu={gpu} />
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setConfirm(true)}>
                {g.continueCpuEllipsis}
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
      <FieldError message={gpuError ?? errors.cpuInferenceAccepted} />
      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <ConfirmLayout
            title={g.consentTitle}
            description={g.cpuWarning}
            actions={
              <>
                <Button onClick={() => setConfirm(false)}>{g.cancel}</Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    setConfirm(false);
                    update({ cpuInferenceAccepted: true });
                  }}
                >
                  {g.continueCpu}
                </Button>
              </>
            }
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
