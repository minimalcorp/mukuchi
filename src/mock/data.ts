/* モックの初期データ */
import type { AppStatus, AudioDevice, AudioLevel, Permissions, ProvisioningStatus, Settings } from "@/lib/ipc";
import type { MockApi } from "./index";

export type MockDb = {
  status: AppStatus;
  settings: Settings;
  permissions: Permissions;
  provisioning: ProvisioningStatus;
  level: AudioLevel;
  devices: AudioDevice[];
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
};

export const GB = 1_000_000_000;

export function provisioning(stage: ProvisioningStatus["stage"], modelDone = 0.9 * GB): ProvisioningStatus {
  const runtimeTotal = 1.2 * GB;
  const modelTotal = 2.4 * GB;
  const done = stage === "done";
  const idle = stage === "idle";
  return {
    stage,
    items: [
      { id: "runtime", state: idle ? "pending" : "done", bytesDone: idle ? 0 : runtimeTotal, bytesTotal: runtimeTotal },
      {
        id: "model",
        state: done ? "done" : idle ? "pending" : "active",
        bytesDone: done ? modelTotal : idle ? 0 : modelDone,
        bytesTotal: modelTotal,
      },
      { id: "verify", state: done ? "done" : "pending", bytesDone: 0, bytesTotal: null },
    ],
    bytesDone: idle ? 0 : done ? runtimeTotal + modelTotal : runtimeTotal + modelDone,
    bytesTotal: runtimeTotal + modelTotal,
    etaSeconds: done || idle ? null : 180,
    error: stage === "error" ? "ダウンロードに失敗しました。ネットワーク接続を確認してください。" : null,
  };
}

export function createDb(): MockDb {
  return {
    status: { phase: "off", loadingProgress: null, error: null },
    settings: structuredClone(DEFAULT_SETTINGS),
    permissions: { microphone: "granted", accessibility: true },
    provisioning: provisioning("done"),
    level: { level: 0.18, threshold: 0.55, speech: false },
    devices: [
      { id: "builtin", name: "MacBook Pro のマイク", isDefault: true },
      { id: "airpods", name: "AirPods Pro", isDefault: false },
      { id: "usb", name: "USB オーディオ", isDefault: false },
    ],
    levelStream: false,
    onListen: null,
  };
}


