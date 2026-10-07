/*
 * AppError.action (復旧操作) と command の対応。メニューバー (Rust) の復旧項目と同じ操作をする。
 */
import { Download, ExternalLink, RotateCw, Settings as SettingsIcon, type LucideIcon } from "lucide-react";
import type { Messages } from "@/i18n/context";
import { commands, type AppErrorAction } from "./ipc";

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
};

/** Rust が新しい action を足した場合 (フロントが未対応) は null (ボタンを出さない) */
export function errorActionView(action: AppErrorAction | null, t: Messages): ErrorActionView | null {
  if (!action || !Object.hasOwn(ERROR_ACTIONS, action)) return null;
  return { ...ERROR_ACTIONS[action], label: t.errorActions[action] };
}
