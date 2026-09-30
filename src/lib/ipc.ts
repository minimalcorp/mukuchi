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
  | "insert_failed"
  | "vad_failed";

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

/** login_items: launchAtLogin を ON にできなかった時 (承認待ち等) の案内用 */
export type SystemSettingsPane = "microphone" | "accessibility" | "login_items";

export type AppStatus = {
  phase: Phase;
  loadingProgress: number | null;
  error: AppError | null;
  /**
   * 状態の通し番号 (Rust が遷移ごとに増やす)。届く順序が前後しても古い状態で上書きしないために使う
   */
  seq: number;
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
  /**
   * Rust (ドラッグ) だけが書く。フロントエンドは null (既定位置に戻す) にする時だけ送る。
   * version なしは旧形式 (起動時に Rust が移行する)
   */
  panelPosition: { x: number; y: number; displayId: string; version?: number } | null;
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
/** panel の大きさが変わる時に固定する辺・角。描画内容もこの基準に寄せて配置する */
export type PanelAnchor = { horizontal: "left" | "center" | "right"; vertical: "top" | "bottom" };
export type SettingsCategory = "general" | "voice" | "commands" | "recognition" | "permissions" | "storage" | "about";

// ---------- エラー ----------

/** Rust は表示用の日本語メッセージ (文字列) で reject する */
export class IpcError extends Error {
  readonly command: string;
  constructor(command: string, message: string) {
    super(message);
    this.name = "IpcError";
    this.command = command;
  }
}

function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args).catch((e: unknown) => {
    const message = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
    throw new IpcError(command, message);
  });
}

/**
 * 結果を待たない操作用。失敗は状態の変化 (status-changed 等) で表示されるため、ここではログだけ残す
 * (捕捉しないと unhandled rejection になる)。
 */
export function runCommand(p: Promise<unknown>): void {
  p.catch((e: unknown) => {
    console.warn(e);
  });
}

// ---------- commands ----------

export const commands = {
  getStatus: () => call<AppStatus>("get_status"),
  setListening: (on: boolean) => call<void>("set_listening", { on }),
  getSettings: () => call<Settings>("get_settings"),
  updateSettings: (patch: Partial<Settings>) => call<Settings>("update_settings", { patch }),
  listInputDevices: () => call<AudioDevice[]>("list_input_devices"),
  getPermissions: () => call<Permissions>("get_permissions"),
  requestMicrophone: () => call<Permissions>("request_microphone"),
  openSystemSettings: (pane: SystemSettingsPane) => call<void>("open_system_settings", { pane }),
  restartAsr: () => call<void>("restart_asr"),
  getProvisioningStatus: () => call<ProvisioningStatus>("get_provisioning_status"),
  startProvisioning: () => call<void>("start_provisioning"),
  pauseProvisioning: () => call<void>("pause_provisioning"),
  getStorageUsage: () => call<StorageUsage>("get_storage_usage"),
  deleteRuntimeAndModel: () => call<void>("delete_runtime_and_model"),
  getUninstallTargets: () => call<UninstallTarget[]>("get_uninstall_targets"),
  uninstall: () => call<void>("uninstall"),
  listRunningApps: () => call<RunningApp[]>("list_running_apps"),
  openLogsFolder: () => call<void>("open_logs_folder"),
  getAppInfo: () => call<AppInfo>("get_app_info"),
  openSettings: (category?: SettingsCategory) => call<void>("open_settings", { category }),
  /** panel の描画内容 (影の余白込み) の大きさ。論理ピクセル (CSS px) */
  setPanelSize: (width: number, height: number) => call<void>("set_panel_size", { width, height }),
  getPanelAnchor: () => call<PanelAnchor>("get_panel_anchor"),
  completeSetup: () => call<void>("complete_setup"),
  openSetup: () => call<void>("open_setup"),
  /** setup の動作テストで panel を出す (セットアップ完了前は panel を表示しないため) */
  showPanel: () => call<void>("show_panel"),
  /** panel の右クリックメニュー (メニューバーと同じ内容)。座標は panel ウィンドウ内の論理ピクセル */
  showPanelMenu: (x: number, y: number) => call<void>("show_panel_menu", { x, y }),
};

// ---------- events ----------

export type EventMap = {
  "status-changed": AppStatus;
  "audio-level": AudioLevel;
  "utterance-started": { id: number };
  "utterance-partial": Utterance;
  "utterance-result": UtteranceResult;
  "settings-changed": Settings;
  "settings-navigate": { category: SettingsCategory };
  "panel-anchor": PanelAnchor;
  "permissions-changed": Permissions;
  "provisioning-progress": ProvisioningStatus;
  // マイクの接続・切断。変化後の一覧を送る (Rust が送らない版でも購読は無害)
  "input-devices-changed": AudioDevice[];
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
  // 一部だけ登録に成功した場合も解除できるよう、個別に保持する
  const pending = entries.map(([name, h]) =>
    onEvent(name, h as (p: EventMap[typeof name]) => void).then((f) => {
      if (disposed) f();
      else unlistens.push(f);
    }),
  );
  Promise.all(pending).then(
    () => {
      if (!disposed) onReady?.();
    },
    (e: unknown) => console.warn("イベントの購読に失敗しました", e),
  );
  return () => {
    disposed = true;
    unlistens.forEach((f) => f());
  };
}

/**
 * 状態を表す event を購読してから fetch で現在値を取る (購読前の遷移を取りこぼさないため)。
 * fetch の応答より後に event が届いていれば、応答は古い可能性があるので捨てる。
 * ウィンドウが再表示された時 (focus / visibilitychange) も取り直す。
 * 非表示中や再作成直後に event を取りこぼしても、表示時に現在値へ戻すため。
 */
export function subscribeWithInitial<E extends EventName>(
  event: E,
  fetch: () => Promise<EventMap[E]>,
  apply: (value: EventMap[E]) => void,
  others: { [K in EventName]?: (payload: EventMap[K]) => void } = {},
): () => void {
  let disposed = false;
  // event を受け取るたびに進める。fetch 開始時から変わっていれば、その応答は event より古い可能性がある
  let seq = 0;
  const refetch = () => {
    const at = seq;
    fetch().then(
      (v) => {
        if (!disposed && at === seq) apply(v);
      },
      (e: unknown) => {
        console.warn(e);
      },
    );
  };
  const handlers = {
    ...others,
    [event]: (payload: EventMap[E]) => {
      seq += 1;
      apply(payload);
    },
  } as { [K in EventName]?: (payload: EventMap[K]) => void };
  const unsubscribe = subscribeEvents(handlers, refetch);
  const onVisibility = () => {
    if (document.visibilityState === "visible") refetch();
  };
  window.addEventListener("focus", refetch);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    disposed = true;
    unsubscribe();
    window.removeEventListener("focus", refetch);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

/**
 * AppStatus.seq が前回反映したものより小さい状態を捨てる apply を作る。
 * event と get_status の応答、複数の event の届く順序が前後しても古い状態に戻さないため。
 */
export function latestStatusOnly(apply: (s: AppStatus) => void): (s: AppStatus) => void {
  let last: number | null = null;
  return (s) => {
    if (last != null && s.seq < last) return;
    last = s.seq;
    apply(s);
  };
}
