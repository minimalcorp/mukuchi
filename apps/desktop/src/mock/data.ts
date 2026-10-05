/* モックの初期データ */
import type {
  AppStatus,
  AudioDevice,
  AudioLevel,
  ModelInfo,
  PanelAnchor,
  Permissions,
  ProvisioningStatus,
  Settings,
  ShortcutStatus,
  UpdateStatus,
} from "@/lib/ipc";
import type { MockApi } from "./index";

export type MockDb = {
  status: AppStatus;
  settings: Settings;
  permissions: Permissions;
  provisioning: ProvisioningStatus;
  /** list_models の値 (カタログ順) */
  models: ModelInfo[];
  /** get_shortcut_status の値 */
  shortcut: ShortcutStatus;
  /** set_shortcut_suspended の状態 (記録中に登録を一時解除しているか) */
  shortcutSuspended: boolean;
  /** 登録できない (OS が拒否する) 想定のショートカット。update_settings で設定すると reject する */
  shortcutRejected: string[];
  /** select_model を読み込みの途中で失敗させる (元のモデルに戻して reject する) 時のメッセージ */
  modelSelectFail: string | null;
  level: AudioLevel;
  devices: AudioDevice[];
  /** panel のアンカー (get_panel_anchor の値) */
  anchor: PanelAnchor;
  /** get_update_status の値 */
  update: UpdateStatus;
  /** check_for_update で見つかる新しい版。null なら最新 */
  updateLatest: string | null;
  /** install_update で失敗させるメッセージ。Rust と同じく error に遷移してから同じメッセージで reject する */
  updateInstallError: string | null;
  /** true の時はレベルを揺らす (live 表示用) */
  levelStream: boolean;
  /** set_listening(true) の時に呼ぶ (live シナリオで発話を流す) */
  onListen: ((api: MockApi) => void) | null;
};

const DEFAULT_SETTINGS: Settings = {
  launchAtLogin: true,
  inputDeviceId: null,
  vadSensitivity: 60,
  silenceMs: 1300,
  voiceCommandsEnabled: true,
  voiceCommands: [
    { id: "confirm", phrases: ["確定", "エンター"], key: { key: "enter", modifiers: [] } },
    { id: "newline", phrases: ["改行"], key: { key: "enter", modifiers: ["shift"] } },
    { id: "send", phrases: ["送信"], key: { key: "enter", modifiers: ["cmd"] } },
  ],
  asrContext: [
    "macOS アプリの開発についての話です。",
    "以下の用語は英字で表記する: mukuchi (読み: むくち), Qwen3-ASR (読み: クウェン、クエン), Tauri (読み: タウリ), Claude Code (読み: クロードコード), pnpm",
  ].join("\n"),
  excludedApps: [
    { bundleId: "com.1password.1password", name: "1Password" },
    { bundleId: "com.apple.Terminal", name: "ターミナル" },
  ],
  panelPosition: null,
  setupCompleted: true,
  panelStyle: "full",
  inputMode: "continuous",
  autoCheckUpdates: true,
  shortcut: "Alt+Space",
};

export const GB = 1_000_000_000;

export const MODEL_TOTAL = 2.4 * GB;

/** カタログ (Rust の provisioning/models.rs の CATALOG と同じ値) */
const CATALOG = [
  {
    id: "ja-8bit",
    name: "日本語 (8bit)",
    description: "元のモデルと同等の精度で、より速く、メモリの使用量が少ない (約3GB)",
    sizeBytes: 2_185_804_096,
    recommended: true,
    legacy: false,
  },
  {
    id: "ja-bf16",
    name: "日本語 (bf16)",
    description: "量子化していない元のモデル。容量とメモリの使用量 (約8.5GB) が大きい",
    sizeBytes: 4_092_092_275,
    recommended: false,
    // 旧候補: 手元にある時だけ一覧に出る (docs/architecture.md「モデルの管理」の旧候補)
    legacy: true,
  },
] as const;

export type ModelId = (typeof CATALOG)[number]["id"];

/**
 * Rust の list_models と同じく、旧候補は選択中か手元にある時だけ出す (not_downloaded かつ未選択なら除く)。
 * カタログにない id (テストで足した行) はそのまま出す
 */
export function visibleModels(models: ModelInfo[]): ModelInfo[] {
  return models.filter(
    (m) => !(CATALOG.find((c) => c.id === m.id)?.legacy && m.state === "not_downloaded" && !m.selected),
  );
}

/**
 * Rust と同じ形の ModelInfo を作る。bytesDone は downloading・paused・error の時だけ使う
 * (downloaded は sizeBytes、not_downloaded は 0)。diskBytes は手元のファイルの量
 */
export function model(
  id: ModelId,
  state: ModelInfo["state"],
  opts: { selected?: boolean; bytesDone?: number; eta?: number | null; error?: string } = {},
): ModelInfo {
  // legacy は Rust の ModelInfo にない (返す値に含めない)
  const { name, description, sizeBytes, recommended } = CATALOG.find((m) => m.id === id)!;
  const c = { id, name, description, sizeBytes, recommended };
  const bytesDone =
    state === "downloaded" ? c.sizeBytes : state === "not_downloaded" ? 0 : (opts.bytesDone ?? 0.9 * GB);
  return {
    ...c,
    selected: opts.selected ?? false,
    state,
    bytesDone,
    etaSeconds: state === "downloading" ? (opts.eta === undefined ? 180 : opts.eta) : null,
    error: state === "error" ? (opts.error ?? "モデルのダウンロードに失敗しました。ネットワーク接続を確認してください。") : null,
    diskBytes: bytesDone,
  };
}

type ItemId = ProvisioningStatus["items"][number]["id"];
const ORDER: ItemId[] = ["runtime", "model", "verify"];

/**
 * Rust と同じ形の ProvisioningStatus を作る。
 * - items は常に runtime, model, verify の 3 件。paused・error の時は止まった項目 (stoppedAt) が active のまま
 * - runtime・verify の bytesTotal は常に null。model の bytesTotal はファイル一覧の取得後 (model 開始以降) に決まる
 * - 全体の bytesDone/bytesTotal は model のみ。etaSeconds は model の取得中のみ
 */
export function provisioning(
  stage: ProvisioningStatus["stage"],
  opts: { modelDone?: number; stoppedAt?: ItemId; eta?: number | null } = {},
): ProvisioningStatus {
  const { modelDone = 0.9 * GB, stoppedAt = "model", eta = 180 } = opts;
  const current: ItemId | null =
    stage === "runtime" || stage === "model" || stage === "verify"
      ? stage
      : stage === "paused" || stage === "error"
        ? stoppedAt
        : null;
  const idx = stage === "done" ? ORDER.length : current ? ORDER.indexOf(current) : -1;
  const stateOf = (i: number) => (i < idx ? "done" : i === idx ? "active" : "pending");
  const modelState = stateOf(1);
  const modelTotal = modelState === "pending" ? null : MODEL_TOTAL;
  const modelBytes = modelState === "done" ? MODEL_TOTAL : modelState === "active" ? modelDone : 0;
  return {
    stage,
    items: [
      { id: "runtime", state: stateOf(0), bytesDone: 0, bytesTotal: null },
      { id: "model", state: modelState, bytesDone: modelBytes, bytesTotal: modelTotal },
      { id: "verify", state: stateOf(2), bytesDone: 0, bytesTotal: null },
    ],
    bytesDone: modelBytes,
    bytesTotal: modelTotal,
    etaSeconds: stage === "model" ? eta : null,
    error:
      stage === "error"
        ? stoppedAt === "model"
          ? "モデルのダウンロードに失敗しました。ネットワーク接続を確認してください。"
          : stoppedAt === "runtime"
            ? "実行環境を導入できませんでした。"
            : "動作確認に失敗しました。"
        : null,
  };
}

export const UPDATE_TOTAL = 40_000_000;
/** スクリーンショットの比較のため固定の時刻 (日付は「今日」にして時刻だけを出す) */
const CHECKED_AT = (() => {
  const d = new Date();
  d.setHours(14, 32, 0, 0);
  return Math.floor(d.getTime() / 1000);
})();

/** Rust と同じ形の UpdateStatus を作る */
export function updateStatus(state: UpdateStatus["state"], opts: Partial<UpdateStatus> = {}): UpdateStatus {
  const found = state === "downloading" || state === "ready" || state === "installing";
  return {
    state,
    currentVersion: "0.1.0",
    latestVersion: found ? "0.2.0" : null,
    notes: null,
    bytesDone: state === "downloading" ? 0.35 * UPDATE_TOTAL : 0,
    bytesTotal: found ? UPDATE_TOTAL : null,
    checkedAt: state === "unavailable" ? null : CHECKED_AT,
    error: null,
    ...opts,
  };
}

export function createDb(): MockDb {
  return {
    status: { phase: "off", loadingProgress: null, error: null, seq: 0 },
    settings: structuredClone(DEFAULT_SETTINGS),
    permissions: { microphone: "granted", accessibility: true },
    provisioning: provisioning("done"),
    // 新規の導入: 旧候補 (bf16) は出ない
    models: [model("ja-8bit", "downloaded", { selected: true })],
    shortcut: { shortcut: DEFAULT_SETTINGS.shortcut, registered: true, error: null },
    shortcutSuspended: false,
    // エラー表示の確認用。実機で何が拒否されるかは OS 次第 (他アプリと同じキーでも登録は成功しうる)
    shortcutRejected: ["Cmd+Space", "Ctrl+Space"],
    modelSelectFail: null,
    level: { level: 0.18, threshold: 0.55, speech: false },
    devices: [
      { id: "builtin", name: "MacBook Pro のマイク", isDefault: true },
      { id: "airpods", name: "AirPods Pro", isDefault: false },
      { id: "usb", name: "USB オーディオ", isDefault: false },
    ],
    anchor: { horizontal: "center", vertical: "bottom" },
    update: updateStatus("idle"),
    updateLatest: null,
    updateInstallError: null,
    levelStream: false,
    onListen: null,
  };
}


