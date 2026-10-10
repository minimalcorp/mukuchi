/*
 * AppError.action (復旧操作) と command の対応。メニューバー・タスクトレイ (Rust) の復旧項目と同じ操作をする。
 */
import { Cpu, Download, ExternalLink, RefreshCw, RotateCw, Settings as SettingsIcon, type LucideIcon } from "lucide-react";
import type { Messages } from "@/i18n/context";
import { commands, type AppErrorAction } from "./ipc";
import { pickOs, type PerOs, type Platform } from "./platform";

export type ErrorActionView = {
  label: string;
  icon: LucideIcon;
  run: () => Promise<void>;
};

// 文言は辞書の errorActions (同じキー)
const ERROR_ACTIONS: Record<AppErrorAction, Omit<ErrorActionView, "label">> = {
  open_accessibility: { icon: ExternalLink, run: () => commands.openSystemSettings("accessibility") },
  open_microphone: { icon: ExternalLink, run: () => commands.openSystemSettings("microphone") },
  select_microphone: { icon: SettingsIcon, run: () => commands.openSettings("voice") },
  restart_asr: { icon: RotateCw, run: () => commands.restartAsr() },
  start_setup: { icon: Download, run: () => commands.openSetup() },
  // 同意は利用者が注意書きを読んでからにするため、ここでは同意せず設定の「認識」(同意の案内) を開く
  accept_cpu: { icon: Cpu, run: () => commands.openSettings("recognition") },
  probe_gpu: { icon: RefreshCw, run: () => commands.probeGpu().then(() => {}) },
};

/** 辞書の文言は OS で変わるもの (PerOs) と変わらないもの (文字列) がある */
function label(value: string | PerOs<string>, platform: Platform): string {
  return typeof value === "string" ? value : pickOs(value, platform);
}

/** Rust が新しい action を足した場合 (フロントが未対応) は null (ボタンを出さない) */
export function errorActionView(action: AppErrorAction | null, t: Messages, platform: Platform): ErrorActionView | null {
  if (!action || !Object.hasOwn(ERROR_ACTIONS, action)) return null;
  return { ...ERROR_ACTIONS[action], label: label(t.errorActions[action], platform) };
}
