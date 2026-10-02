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
} from "@/lib/ipc";
import type { MockApi } from "./index";

export type MockDb = {
  status: AppStatus;
  settings: Settings;
  permissions: Permissions;
  provisioning: ProvisioningStatus;
  /** list_models の値 (カタログ順) */
  models: ModelInfo[];
  /** select_model を読み込みの途中で失敗させる (元のモデルに戻して reject する) 時のメッセージ */
  modelSelectFail: string | null;
  level: AudioLevel;
  devices: AudioDevice[];
  /** panel のアンカー (get_panel_anchor の値) */
  anchor: PanelAnchor;
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
  vocabulary: ["mukuchi", "Qwen3-ASR", "Tauri", "Apple Silicon", "株式会社Minimal", "Kubernetes"],
  excludedApps: [
    { bundleId: "com.1password.1password", name: "1Password" },
    { bundleId: "com.apple.Terminal", name: "ターミナル" },
  ],
  panelPosition: null,
  setupCompleted: true,
  panelStyle: "full",
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

export function createDb(): MockDb {
  return {
    status: { phase: "off", loadingProgress: null, error: null, seq: 0 },
    settings: structuredClone(DEFAULT_SETTINGS),
    permissions: { microphone: "granted", accessibility: true },
    provisioning: provisioning("done"),
    // 新規の導入: 旧候補 (bf16) は出ない
    models: [model("ja-8bit", "downloaded", { selected: true })],
    modelSelectFail: null,
    level: { level: 0.18, threshold: 0.55, speech: false },
    devices: [
      { id: "builtin", name: "MacBook Pro のマイク", isDefault: true },
      { id: "airpods", name: "AirPods Pro", isDefault: false },
      { id: "usb", name: "USB オーディオ", isDefault: false },
    ],
    anchor: { horizontal: "center", vertical: "bottom" },
    levelStream: false,
    onListen: null,
  };
}


