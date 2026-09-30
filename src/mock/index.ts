/*
 * 開発用モック (npm run dev のブラウザ表示・Playwright 用)。本番ビルドには含まれない。
 * @tauri-apps/api/mocks で IPC とイベントを差し替え、?window= と ?mock= で画面・状態を選ぶ。
 * シナリオ一覧は src/mock/scenarios.ts。
 * &unimplemented=<command,...> で指定した command を未実装 (`not_implemented:` で reject) にできる。
 * &slow=<command,...> で指定した command の応答を 500ms 遅らせる (初期値取得と event の順序の確認用)。
 * window.__mukuchiMock.fail[<command>] = "<メッセージ>" でその command を失敗させられる (エラー表示の確認用)。
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type {
  AppStatus,
  AudioLevel,
  EventMap,
  EventName,
  Settings,
  SettingsCategory,
  Utterance,
  UtteranceResult,
} from "@/lib/ipc";
import { devOverrides } from "@/lib/env";
import { findScenario } from "./scenarios";
import { createDb, provisioning, GB, type MockDb } from "./data";

function fire<E extends EventName>(event: E, payload: EventMap[E]) {
  void emit(event, payload);
}

export function installMock(params: URLSearchParams) {
  const windowLabel = params.get("window") ?? "settings";
  const scenario = findScenario(windowLabel, params.get("mock") ?? "default");
  const db = createDb();
  scenario.setup?.(db);
  // 静止状態のシナリオは確定結果・エラー表示を消さない
  devOverrides.holdResults = !scenario.live;
  const step = Number(params.get("step")) || scenario.step || null;
  devOverrides.setupStep = step;

  mockWindows(windowLabel, "panel", "settings", "setup");
  // Rust の現状に合わせて未実装の command を指定できる
  const unimplemented = new Set([
    ...(scenario.unimplemented ?? []),
    ...(params.get("unimplemented")?.split(",").filter(Boolean) ?? []),
  ]);
  const slow = new Set(params.get("slow")?.split(",").filter(Boolean) ?? []);

  let scriptStarted = false;
  let levelTimer: ReturnType<typeof setInterval> | null = null;
  let provisioningTimer: ReturnType<typeof setInterval> | null = null;

  const setStatus = (patch: Partial<AppStatus>) => {
    db.status = { ...db.status, ...patch };
    fire("status-changed", db.status);
  };

  // 入力レベルを約15Hz で流す。静止シナリオでは同じ値を流し続ける (購読が後から始まっても表示されるように)
  const startLevel = () => {
    if (levelTimer) return;
    let t = 0;
    levelTimer = setInterval(() => {
      t += 1;
      const base = db.level;
      const jitter = db.levelStream ? (Math.sin(t / 2) + Math.sin(t / 3.7)) * 0.06 : 0;
      const level: AudioLevel = { ...base, level: Math.min(1, Math.max(0, base.level + jitter)) };
      fire("audio-level", level);
    }, 66);
  };
  startLevel();

  const api: MockApi = {
    db,
    calls: [],
    fail: {},
    invoke: (cmd, args) => invoke(cmd, args),
    setStatus,
    fire,
    started: (id) => fire("utterance-started", { id }),
    partial: (u: Utterance) => fire("utterance-partial", u),
    result: (r: UtteranceResult) => fire("utterance-result", r),
    setLevel: (level: number, speech = false) => {
      db.level = { ...db.level, level, speech };
    },
    // 実機では Rust が ⌘V で前面アプリ (フォーカス中の欄) に貼り付ける。モックではフォーカス中の欄に直接入れる
    typeIntoFocused: (text: string) => {
      const el = document.activeElement;
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        el.setRangeText(text, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, "end");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    },
  };

  const startProvisioningTicker = () => {
    if (provisioningTimer) return;
    provisioningTimer = setInterval(() => {
      const p = db.provisioning;
      if (p.stage === "paused" || p.stage === "error" || p.stage === "done") {
        if (provisioningTimer) clearInterval(provisioningTimer);
        provisioningTimer = null;
        return;
      }
      const model = p.items.find((i) => i.id === "model");
      const next = Math.min(2.4 * GB, (model?.bytesDone ?? 0) + 0.05 * GB);
      db.provisioning = next >= 2.4 * GB ? provisioning("done") : provisioning("model", next);
      fire("provisioning-progress", db.provisioning);
    }, 250);
  };

  mockIPC(
    async (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      if (!cmd.startsWith("plugin:")) api.calls.push({ cmd, args: a });
      if (unimplemented.has(cmd)) {
        // Rust と同じく文字列で reject する
        return Promise.reject(`not_implemented: ${cmd} は未実装です`);
      }
      const failure = api.fail[cmd];
      if (failure != null) return Promise.reject(failure);
      if (slow.has(cmd)) {
        // 応答時点の値ではなく、呼ばれた時点の値を返す (遅れて届く古い応答を再現する)
        const snapshot = cmd === "get_status" ? db.status : undefined;
        await new Promise((r) => setTimeout(r, 500));
        if (snapshot) return snapshot;
      }
      switch (cmd) {
        case "get_status":
          if (!scriptStarted && scenario.script) {
            scriptStarted = true;
            // 購読済みのリスナーに届くよう、応答を返してから流す
            setTimeout(() => scenario.script?.(api), 0);
          }
          return db.status;
        case "set_listening": {
          const on = Boolean(a.on);
          setStatus({ phase: on ? "listening" : "off", error: null });
          if (on) db.onListen?.(api);
          return null;
        }
        case "get_settings":
          return db.settings;
        case "update_settings":
          db.settings = { ...db.settings, ...(a.patch as Partial<Settings>) };
          fire("settings-changed", db.settings);
          return db.settings;
        case "list_input_devices":
          return db.devices;
        case "get_permissions":
          return db.permissions;
        case "request_microphone":
          db.permissions = { ...db.permissions, microphone: "granted" };
          fire("permissions-changed", db.permissions);
          return db.permissions;
        case "open_system_settings":
          // システム設定で許可した想定。1.5 秒後に許可済みにする (setup の 1 秒ごとの再取得で反映される)
          setTimeout(() => {
            const pane = a.pane as string;
            db.permissions =
              pane === "accessibility"
                ? { ...db.permissions, accessibility: true }
                : { ...db.permissions, microphone: "granted" };
          }, 1500);
          return null;
        case "restart_asr":
          setStatus({ phase: "loading", loadingProgress: null, error: null });
          return null;
        case "get_provisioning_status":
          return db.provisioning;
        case "start_provisioning":
          db.provisioning = { ...provisioning("model", db.provisioning.items[1]?.bytesDone ?? 0), error: null };
          fire("provisioning-progress", db.provisioning);
          startProvisioningTicker();
          return null;
        case "pause_provisioning":
          db.provisioning = { ...db.provisioning, stage: "paused", etaSeconds: null };
          fire("provisioning-progress", db.provisioning);
          return null;
        case "get_storage_usage":
          return db.provisioning.stage === "done"
            ? { runtimeBytes: 1.2 * GB, modelBytes: 2.4 * GB, otherBytes: 12_000_000 }
            : { runtimeBytes: 0, modelBytes: 0, otherBytes: 12_000_000 };
        case "delete_runtime_and_model":
          db.provisioning = provisioning("idle");
          return null;
        case "get_uninstall_targets":
          return [
            { path: "/Applications/mukuchi.app", bytes: 48_000_000 },
            { path: "~/Library/Application Support/com.minimalcorp.mukuchi", bytes: 3.6 * GB },
            { path: "~/Library/Caches/com.minimalcorp.mukuchi", bytes: 21_000_000 },
            { path: "~/Library/Logs/com.minimalcorp.mukuchi", bytes: 12_000_000 },
            { path: "~/Library/WebKit/com.minimalcorp.mukuchi", bytes: 2_000_000 },
            { path: "~/Library/Preferences/com.minimalcorp.mukuchi.plist", bytes: 4_000 },
          ];
        case "uninstall":
          return new Promise((resolve) => setTimeout(() => resolve(null), 800));
        case "list_running_apps":
          return [
            { bundleId: "com.apple.Safari", name: "Safari" },
            { bundleId: "com.apple.Notes", name: "メモ" },
            { bundleId: "com.tinyspeck.slackmacgap", name: "Slack" },
            { bundleId: "com.apple.Terminal", name: "ターミナル" },
            { bundleId: "com.microsoft.VSCode", name: "Visual Studio Code" },
          ];
        case "open_settings":
          // Rust は設定ウィンドウが開いていれば前面に出して settings-navigate を送る
          if (windowLabel === "settings" && a.category) {
            fire("settings-navigate", { category: a.category as SettingsCategory });
          }
          return null;
        case "set_panel_size":
        case "open_logs_folder":
        case "open_setup":
        case "complete_setup":
          return null;
        case "get_app_info":
          return { version: "0.1.0", build: "42" };
        default:
          // ウィンドウ API 等 (plugin:window|...) は何もしない
          return null;
      }
    },
    { shouldMockEvents: true },
  );

  // デバッグ用: コンソールから window.__mukuchiMock.fire(...) 等で状態を動かせる
  (window as unknown as { __mukuchiMock: MockApi }).__mukuchiMock = api;
}

export type MockApi = {
  db: MockDb;
  /** 呼ばれた command と引数 (plugin:* を除く)。Playwright から確認する */
  calls: { cmd: string; args: Record<string, unknown> }[];
  /** command 名 → reject するメッセージ (Rust の表示用メッセージの代わり) */
  fail: Record<string, string>;
  /** Tauri の invoke (他ウィンドウからの command 呼び出しを再現する) */
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  setStatus: (patch: Partial<AppStatus>) => void;
  fire: typeof fire;
  started: (id: number) => void;
  partial: (u: Utterance) => void;
  result: (r: UtteranceResult) => void;
  setLevel: (level: number, speech?: boolean) => void;
  typeIntoFocused: (text: string) => void;
};
