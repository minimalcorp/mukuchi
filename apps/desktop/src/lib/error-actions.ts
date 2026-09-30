/*
 * AppError.action (復旧操作) と command の対応。メニューバー (Rust) の復旧項目と同じ操作をする。
 */
import { Download, ExternalLink, RotateCw, Settings as SettingsIcon, type LucideIcon } from "lucide-react";
import { commands, type AppErrorAction } from "./ipc";

export type ErrorActionView = {
  label: string;
  icon: LucideIcon;
  run: () => Promise<void>;
};

export const ERROR_ACTIONS: Record<AppErrorAction, ErrorActionView> = {
  open_accessibility: {
    label: "システム設定を開く",
    icon: ExternalLink,
    run: () => commands.openSystemSettings("accessibility"),
  },
  open_microphone: {
    label: "システム設定を開く",
    icon: ExternalLink,
    run: () => commands.openSystemSettings("microphone"),
  },
  select_microphone: {
    label: "マイクを選択",
    icon: SettingsIcon,
    run: () => commands.openSettings("voice"),
  },
  restart_asr: { label: "再起動", icon: RotateCw, run: () => commands.restartAsr() },
  start_setup: { label: "セットアップを開く", icon: Download, run: () => commands.openSetup() },
};

/** Rust が新しい action を足した場合 (フロントが未対応) は null (ボタンを出さない) */
export function errorActionView(action: AppErrorAction | null): ErrorActionView | null {
  if (!action) return null;
  return Object.hasOwn(ERROR_ACTIONS, action) ? ERROR_ACTIONS[action] : null;
}
