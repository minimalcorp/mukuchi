/* モックの初期データ */
import type { AppStatus, AudioDevice, AudioLevel, PanelAnchor, Permissions, ProvisioningStatus, Settings } from "@/lib/ipc";
import type { MockApi } from "./index";

export type MockDb = {
  status: AppStatus;
  settings: Settings;
  permissions: Permissions;
  provisioning: ProvisioningStatus;
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


