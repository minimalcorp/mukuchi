/*
 * GPU の判定結果 (GpuStatus) の表示 (Windows のみ。docs/architecture.md「GPU の判定と CPU 実行の同意」)
 */
import type { Messages } from "@/i18n/context";
import type { GpuStatus } from "./ipc";

/** GPU が使えない (CPU 実行の同意の対象) か */
export function gpuUnusable(gpu: GpuStatus): boolean {
  return gpu.kind === "none" || gpu.kind === "driver_missing";
}

/** 使うデバイスの表示。title: デバイスの名前 (GPU の名前・CPU)、sub: 説明 */
export function gpuDeviceView(gpu: GpuStatus, t: Messages): { device: "gpu" | "cpu"; title: string; sub: string } {
  const g = t.gpu;
  if (gpu.device === "cpu") return { device: "cpu", title: g.cpu, sub: g.cpuSub };
  if (gpuUnusable(gpu)) {
    // 同意前 (CPU でも動かしていない)
    return { device: "gpu", title: gpu.kind === "none" ? g.noneTitle : g.driverTitle, sub: gpu.kind === "none" ? g.noneLead : g.driverLead };
  }
  if (gpu.kind === "integrated") return { device: "gpu", title: gpu.selected ?? g.integrated, sub: g.integratedSub };
  return { device: "gpu", title: gpu.selected ?? g.gpu, sub: g.okSub };
}

/** 設定の「認識」の「〜で実行中」。GPU の名前が分からなければ null (OS ごとの既定の文言を使う) */
export function runningOnText(gpu: GpuStatus, t: Messages): string | null {
  const r = t.settings.recognition;
  if (gpu.device === "cpu") return r.runningOnCpu;
  return gpu.selected ? r.runningOn(gpu.selected) : null;
}
