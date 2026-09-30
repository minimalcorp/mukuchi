/*
 * Rust との通信の型付きラッパー。型・名前は docs/architecture.md「インターフェース」と同期する。
 * Rust 側が正。変更する場合は architecture.md を先に更新する。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// ---------- 型 ----------

export type Phase = "loading" | "off" | "listening" | "speaking" | "finalizing" | "done" | "error";

export type AppErrorCode =
  | "accessibility_denied"
  | "microphone_denied"
  | "microphone_missing"
  | "asr_stopped"
  | "runtime_missing"
  | "insert_failed";

export type AppErrorAction =
  | "open_accessibility"
  | "open_microphone"
  | "select_microphone"
  | "restart_asr"
  | "start_setup";

export type AppError = {
  code: AppErrorCode;
  message: string;
  action: AppErrorAction | null;
};

export type AppStatus = {
  phase: Phase;
  loadingProgress: number | null;
  error: AppError | null;
};

export type Utterance = {
  id: number;
  text: string;
  stableLength: number;
};

export type UtteranceResult =
  | { kind: "inserted"; id: number; text: string; appName: string }
  | { kind: "command"; id: number; text: string; key: string }
  | { kind: "skipped_excluded"; id: number; text: string; appName: string }
  | { kind: "empty"; id: number }
  | { kind: "discarded"; id: number }
  | { kind: "failed"; id: number; text: string; error: AppError };

export type KeyName = "enter" | "tab" | "escape" | "backspace";
export type Modifier = "cmd" | "shift" | "option" | "ctrl";
export type KeyCombo = { key: KeyName; modifiers: Modifier[] };

export type VoiceCommand = { id: string; phrases: string[]; key: KeyCombo };
export type ExcludedApp = { bundleId: string; name: string };

export type Settings = {
  launchAtLogin: boolean;
  inputDeviceId: string | null;
  vadSensitivity: number;
  silenceMs: number;
  voiceCommandsEnabled: boolean;
  voiceCommands: VoiceCommand[];
  vocabulary: string[];
  excludedApps: ExcludedApp[];
  panelPosition: { x: number; y: number; displayId: string } | null;
  setupCompleted: boolean;
};

export type MicrophonePermission = "granted" | "denied" | "not_determined";
export type Permissions = {
  microphone: MicrophonePermission;
  accessibility: boolean;
};

export type ProvisioningItemId = "runtime" | "model" | "verify";
export type ProvisioningStatus = {
  stage: "idle" | "runtime" | "model" | "verify" | "done" | "paused" | "error";
  items: {
    id: ProvisioningItemId;
    state: "pending" | "active" | "done";
    bytesDone: number;
    bytesTotal: number | null;
  }[];
  bytesDone: number;
  bytesTotal: number | null;
  etaSeconds: number | null;
  error: string | null;
};

export type StorageUsage = { runtimeBytes: number; modelBytes: number; otherBytes: number };
export type AudioDevice = { id: string; name: string; isDefault: boolean };
export type AppInfo = { version: string; build: string };
export type UninstallTarget = { path: string; bytes: number };
export type RunningApp = { bundleId: string; name: string };
export type AudioLevel = { level: number; threshold: number; speech: boolean };

// ---------- commands ----------

export const commands = {
  getStatus: () => invoke<AppStatus>("get_status"),
  setListening: (on: boolean) => invoke<void>("set_listening", { on }),
  getSettings: () => invoke<Settings>("get_settings"),
  updateSettings: (patch: Partial<Settings>) => invoke<Settings>("update_settings", { patch }),
  listInputDevices: () => invoke<AudioDevice[]>("list_input_devices"),
  getPermissions: () => invoke<Permissions>("get_permissions"),
  requestMicrophone: () => invoke<Permissions>("request_microphone"),
  openSystemSettings: (pane: "microphone" | "accessibility") => invoke<void>("open_system_settings", { pane }),
  restartAsr: () => invoke<void>("restart_asr"),
  getProvisioningStatus: () => invoke<ProvisioningStatus>("get_provisioning_status"),
  startProvisioning: () => invoke<void>("start_provisioning"),
  pauseProvisioning: () => invoke<void>("pause_provisioning"),
  getStorageUsage: () => invoke<StorageUsage>("get_storage_usage"),
  deleteRuntimeAndModel: () => invoke<void>("delete_runtime_and_model"),
  getUninstallTargets: () => invoke<UninstallTarget[]>("get_uninstall_targets"),
  uninstall: () => invoke<void>("uninstall"),
  listRunningApps: () => invoke<RunningApp[]>("list_running_apps"),
  openLogsFolder: () => invoke<void>("open_logs_folder"),
  getAppInfo: () => invoke<AppInfo>("get_app_info"),
  openSettings: (category?: string) => invoke<void>("open_settings", { category }),
  completeSetup: () => invoke<void>("complete_setup"),
};

// ---------- events ----------

export type EventMap = {
  "status-changed": AppStatus;
  "audio-level": AudioLevel;
  "utterance-started": { id: number };
  "utterance-partial": Utterance;
  "utterance-result": UtteranceResult;
  "settings-changed": Settings;
  "permissions-changed": Permissions;
  "provisioning-progress": ProvisioningStatus;
};

export type EventName = keyof EventMap;

export function onEvent<E extends EventName>(event: E, handler: (payload: EventMap[E]) => void): Promise<UnlistenFn> {
  return listen<EventMap[E]>(event, (e) => handler(e.payload));
}

/**
 * useEffect から購読するためのヘルパー。listen は非同期に登録されるため、
 * 登録完了前にアンマウントされた場合も確実に解除する。
 * onReady は全イベントの登録完了後に呼ばれる (購読してから初期値を取得し、取りこぼしを防ぐ)。
 */
export function subscribeEvents(
  handlers: { [E in EventName]?: (payload: EventMap[E]) => void },
  onReady?: () => void,
): () => void {
  let disposed = false;
  const unlistens: UnlistenFn[] = [];
  const entries = Object.entries(handlers) as [EventName, (p: unknown) => void][];
  Promise.all(entries.map(([name, h]) => onEvent(name, h as (p: EventMap[typeof name]) => void))).then((fns) => {
    if (disposed) {
      fns.forEach((f) => f());
      return;
    }
    unlistens.push(...fns);
    onReady?.();
  });
  return () => {
    disposed = true;
    unlistens.forEach((f) => f());
  };
}
