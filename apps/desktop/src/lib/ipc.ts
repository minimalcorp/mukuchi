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
  | "vad_failed"
  /** Windows のみ: GPU が使えず CPU 実行への同意 (Settings.cpuInferenceAccepted) もない。action は accept_cpu / probe_gpu */
  | "gpu_unavailable";

export type AppErrorAction =
  | "open_accessibility"
  | "open_microphone"
  | "select_microphone"
  | "restart_asr"
  | "start_setup"
  /** Windows のみ (gpu_unavailable): CPU 実行の同意へ */
  | "accept_cpu"
  /** Windows のみ (gpu_unavailable): GPU の再検出 */
  | "probe_gpu";

export type AppError = {
  code: AppErrorCode;
  /** 表示用 (表示言語。Rust が作る) */
  message: string;
  action: AppErrorAction | null;
};

/**
 * login_items: launchAtLogin を ON にできなかった時 (承認待ち等) の案内用。
 * Windows は「設定」アプリを開く (microphone → ms-settings:privacy-microphone、login_items → ms-settings:startupapps。accessibility は使わない)
 */
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
  /** submitted: 自動送信の送信キーを送った */
  | { kind: "inserted"; id: number; text: string; appName: string; submitted: boolean }
  | { kind: "command"; id: number; text: string; key: string }
  | { kind: "skipped_excluded"; id: number; text: string; appName: string }
  | { kind: "empty"; id: number }
  | { kind: "discarded"; id: number }
  | { kind: "failed"; id: number; text: string; error: AppError };

export type KeyName = "enter" | "tab" | "escape" | "backspace";
/** cmd は Windows では Win キー */
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
  /** 認識のヒント (自由記述)。ASR にそのまま渡す。最大 ASR_CONTEXT_MAX 文字 (Unicode スカラー値) */
  asrContext: string;
  excludedApps: ExcludedApp[];
  /**
   * Rust (ドラッグ) だけが書く。フロントエンドは null (既定位置に戻す) にする時だけ送る。
   * version なしは旧形式 (起動時に Rust が移行する)
   */
  panelPosition: { x: number; y: number; displayId: string; version?: number } | null;
  setupCompleted: boolean;
  /** パネルの表示形式。compact はマイクの円形ボタンのみ (プレビュー・文言なし) */
  panelStyle: PanelStyle;
  /** 入力モード (docs/architecture.md「決定事項」の入力モード) */
  inputMode: InputMode;
  /** 貼り付けた発話の直後に送信キーを送る (docs/architecture.md「決定事項」の自動送信) */
  autoSubmit: boolean;
  /** 自動送信の送信キー。modEnter は主修飾キー+Enter (macOS は ⌘+Enter、Windows は Ctrl+Enter) */
  autoSubmitKey: AutoSubmitKey;
  /** 自動でアップデートを確認・取得する (docs/architecture.md「アップデート」)。false でも手動の確認はできる */
  autoCheckUpdates: boolean;
  /**
   * グローバルショートカット。null は無効。形式は「修飾+…+キー」: 修飾は Ctrl・Alt・Shift・Cmd をこの順で1つ以上、
   * キーは KeyboardEvent.code (例 "Alt+Space" "Shift+Cmd+KeyM")。Cmd は Windows では Win キー。
   * 登録できなければ (形式の誤り・OS が拒否) update_settings は保存せずに reject する。他アプリと同じキーでも登録は成功しうる (衝突は検出できない)
   */
  shortcut: string | null;
  /** 表示言語。system は OS の優先言語から Rust が解決する (get_locale / locale-changed) */
  uiLanguage: "system" | Locale;
  /** 話す言語。ASR の language・推奨モデル・音声コマンドの既定を決める */
  speechLanguage: Locale;
  /** Windows のみ: GPU が使えない PC で CPU 実行に利用者が同意した。Mac では使わない */
  cpuInferenceAccepted: boolean;
};

/** 表示言語・話す言語 (docs/architecture.md「言語」)。対応表は src/i18n/locales.ts の LOCALES */
export type Locale = "ja" | "en";

/** Settings.asrContext の上限 (Rust の検証と同じ値。表示用で、検証の正は Rust) */
export const ASR_CONTEXT_MAX = 1000;

export type PanelStyle = "full" | "compact";
/** continuous: ON の間ずっと発話ごとに入力 (常に聞き取る)。oneShot: 1発話を確定したら自動で OFF (1回ずつ聞き取る) */
export type InputMode = "continuous" | "oneShot";
/** 自動送信の送信キー。OS 非依存の値で持ち、実際のキーは Rust が OS ごとに決める */
export type AutoSubmitKey = "enter" | "modEnter";
/** error: 起動時などに登録できなかった時の表示用 (表示言語) */
export type ShortcutStatus = { shortcut: string | null; registered: boolean; error: string | null };

export type MicrophonePermission = "granted" | "denied" | "not_determined";
export type Permissions = {
  microphone: MicrophonePermission;
  /** Windows にアクセシビリティの権限はないため常に true */
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

/** modelBytes は models/ 全体 (全モデル・取得途中を含む) */
export type StorageUsage = { runtimeBytes: number; modelBytes: number; otherBytes: number };

export type ModelState = "not_downloaded" | "downloading" | "paused" | "error" | "downloaded";
export type ModelInfo = {
  /**
   * カタログの id ("ja-8bit" | "base-1.7b-8bit" | "ja-bf16")。list_models は話す言語の並び (旧候補は末尾) の順で、表示もこの順。
   * 旧候補 (ja-bf16) は手元にある時だけ出る
   */
  id: string;
  /** 表示名 (表示言語) */
  name: string;
  /** 説明 (表示言語) */
  description: string;
  /** 追加学習で特化した言語。元のモデルは null。話す言語と違う時に注記を添える */
  tunedFor: Locale | null;
  /** 取得するファイルの合計 (固定した revision の値)。進捗の分母・未取得時の容量表示 */
  sizeBytes: number;
  /** 話す言語の推奨 (新規のセットアップで取得するもの)。ちょうど1つ */
  recommended: boolean;
  /** 使用中。常にちょうど1つ (セットアップ未完了の間は未取得のことがある) */
  selected: boolean;
  state: ModelState;
  /** downloading・paused・error: 取得済みのバイト数。downloaded: sizeBytes。not_downloaded: 0 */
  bytesDone: number;
  /** downloading のみ (最初の2秒は null) */
  etaSeconds: number | null;
  /** state=error の時の表示用。再試行は download_model */
  error: string | null;
  /** このモデルのディスク上の使用量 (取得途中・古い版を含む) */
  diskBytes: number;
};
export type AudioDevice = { id: string; name: string; isDefault: boolean };
/** platform: ビルドした OS。OS ごとの文言・キー表記の切り替えに使う (src/lib/platform.ts) */
export type AppInfo = { version: string; build: string; platform: "macos" | "windows" };

/**
 * Windows のみ。ASR を動かす GPU の判定結果 (docs/architecture.md「GPU の判定と CPU 実行の同意」)。
 * ok: 独立 GPU あり。integrated: 内蔵 GPU のみ。driver_missing: GPU はあるが推論に使えない (ドライバー)。none: GPU なし
 */
export type GpuKind = "ok" | "integrated" | "driver_missing" | "none";
export type GpuStatus = {
  kind: GpuKind;
  /** Vulkan で推論に使えるもの。driver_missing・none は空 */
  devices: { name: string; vramMb: number | null; integrated: boolean }[];
  /** 使うデバイスの名前 (ok・integrated) */
  selected: string | null;
  /** 実際に使う実行先。cpu は kind が none・driver_missing で cpuInferenceAccepted の時だけ */
  device: "gpu" | "cpu";
};
export type UpdateState = "unavailable" | "idle" | "checking" | "downloading" | "ready" | "installing" | "error";
/** 自動アップデートの状態 (docs/architecture.md「アップデート」) */
export type UpdateStatus = {
  /** unavailable: 開発ビルド・dmg から起動・App Translocation。idle: 未確認か最新 */
  state: UpdateState;
  currentVersion: string;
  /** 見つかった新しい版 (downloading・ready・installing、取得・インストールの失敗時)。最新なら null */
  latestVersion: string | null;
  /** latest.json の notes */
  notes: string | null;
  /** downloading のみ意味がある */
  bytesDone: number;
  /** 大きさが分からなければ null */
  bytesTotal: number | null;
  /** 最後に確認が成功した時刻 (UNIX 秒。このプロセスでの値) */
  checkedAt: number | null;
  /** error・unavailable の時の表示用 (表示言語) */
  error: string | null;
};
export type UninstallTarget = { path: string; bytes: number };
export type RunningApp = { bundleId: string; name: string };
export type AudioLevel = { level: number; threshold: number; speech: boolean };
/** panel の大きさが変わる時に固定する辺・角。描画内容もこの基準に寄せて配置する */
export type PanelAnchor = { horizontal: "left" | "center" | "right"; vertical: "top" | "bottom" };
export type SettingsCategory = "general" | "voice" | "commands" | "recognition" | "permissions" | "storage" | "about";

// ---------- エラー ----------

/** Rust は表示用のメッセージ (表示言語の文字列) で reject する */
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
  getShortcutStatus: () => call<ShortcutStatus>("get_shortcut_status"),
  /** ショートカットの記録中に登録を一時解除する (記録中に押したキーで ON/OFF しないため)。終わったら必ず false で戻す */
  setShortcutSuspended: (suspended: boolean) => call<void>("set_shortcut_suspended", { suspended }),
  /** 解決した表示言語 (uiLanguage が system なら macOS の優先言語から) */
  getLocale: () => call<Locale>("get_locale"),
  getSettings: () => call<Settings>("get_settings"),
  updateSettings: (patch: Partial<Settings>) => call<Settings>("update_settings", { patch }),
  listInputDevices: () => call<AudioDevice[]>("list_input_devices"),
  getPermissions: () => call<Permissions>("get_permissions"),
  requestMicrophone: () => call<Permissions>("request_microphone"),
  /** Windows のみ (Mac は常に ok)。GPU の判定結果 */
  getGpuStatus: () => call<GpuStatus>("get_gpu_status"),
  /** Windows のみ。GPU を判定し直して結果を返す */
  probeGpu: () => call<GpuStatus>("probe_gpu"),
  openSystemSettings: (pane: SystemSettingsPane) => call<void>("open_system_settings", { pane }),
  restartAsr: () => call<void>("restart_asr"),
  getProvisioningStatus: () => call<ProvisioningStatus>("get_provisioning_status"),
  startProvisioning: () => call<void>("start_provisioning"),
  pauseProvisioning: () => call<void>("pause_provisioning"),
  getStorageUsage: () => call<StorageUsage>("get_storage_usage"),
  deleteRuntimeAndModel: () => call<void>("delete_runtime_and_model"),
  listModels: () => call<ModelInfo[]>("list_models"),
  /** ASR を新しいモデルで起動し直し、準備完了まで待って返る。失敗時は元のモデルに戻して reject */
  selectModel: (id: string) => call<void>("select_model", { id }),
  /** 開始・再開・再試行。開始したらすぐ返る (進捗は models-changed) */
  downloadModel: (id: string) => call<void>("download_model", { id }),
  /** 止まるまで待って返る */
  pauseModelDownload: (id: string) => call<void>("pause_model_download", { id }),
  /** 途中のファイルを消して not_downloaded にする */
  cancelModelDownload: (id: string) => call<void>("cancel_model_download", { id }),
  deleteModel: (id: string) => call<void>("delete_model", { id }),
  getUninstallTargets: () => call<UninstallTarget[]>("get_uninstall_targets"),
  uninstall: () => call<void>("uninstall"),
  listRunningApps: () => call<RunningApp[]>("list_running_apps"),
  openLogsFolder: () => call<void>("open_logs_folder"),
  getAppInfo: () => call<AppInfo>("get_app_info"),
  getUpdateStatus: () => call<UpdateStatus>("get_update_status"),
  /** 手動の確認。確認が終わった時点の状態を返す (新しい版があれば取得を始めて downloading)。実行中なら今の状態を返す */
  checkForUpdate: () => call<UpdateStatus>("check_for_update"),
  /** ready の時にインストールして再起動する (成功すると返らない) */
  installUpdate: () => call<void>("install_update"),
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
  "locale-changed": Locale;
  "settings-navigate": { category: SettingsCategory };
  "panel-anchor": PanelAnchor;
  "permissions-changed": Permissions;
  "shortcut-status-changed": ShortcutStatus;
  "provisioning-progress": ProvisioningStatus;
  // マイクの接続・切断。変化後の一覧を送る (Rust が送らない版でも購読は無害)
  "input-devices-changed": AudioDevice[];
  "models-changed": ModelInfo[];
  "update-status-changed": UpdateStatus;
  /** Windows のみ。判定結果が変わった時 (起動時・再検出・同意) */
  "gpu-status-changed": GpuStatus;
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
