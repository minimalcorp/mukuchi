/*
 * 開発用モック (pnpm run dev のブラウザ表示・Playwright 用)。本番ビルドには含まれない。
 * @tauri-apps/api/mocks で IPC とイベントを差し替え、?window= と ?mock= で画面・状態を選ぶ。
 * シナリオ一覧は src/mock/scenarios.ts。
 * &anchor=<top|bottom>-<left|center|right> で panel のアンカー (get_panel_anchor の値) を指定する。
 * &style=<full|compact> で panel の表示形式 (Settings.panelStyle) を指定する。
 * &slow=<command,...> で指定した command の応答を 500ms 遅らせる (初期値取得と event の順序の確認用)。
 * window.__mukuchiMock.fail[<command>] = "<メッセージ>" でその command を失敗させられる (エラー表示の確認用)。
 */
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type {
  AppError,
  AppStatus,
  AudioLevel,
  EventMap,
  PanelAnchor,
  EventName,
  ModelInfo,
  ProvisioningStatus,
  Settings,
  SettingsCategory,
  Utterance,
  UtteranceResult,
} from "@/lib/ipc";
import { devOverrides } from "@/lib/env";
import { findScenario } from "./scenarios";
import { createDb, model, provisioning, visibleModels, GB, MODEL_TOTAL, type MockDb, type ModelId } from "./data";

const HOME = "/Users/you";
const RUNTIME_MISSING: AppError = {
  code: "runtime_missing",
  message: "実行環境とモデルがありません",
  action: "start_setup",
};

/** "top-right" 等を PanelAnchor にする。不正な値は Rust の位置が決まる前と同じ center/bottom */
function parseAnchor(value: string | null): PanelAnchor {
  const [v, h] = (value ?? "").split("-");
  return {
    horizontal: h === "left" || h === "right" ? h : "center",
    vertical: v === "top" ? "top" : "bottom",
  };
}

function fire<E extends EventName>(event: E, payload: EventMap[E]) {
  void emit(event, payload);
}

export function installMock(params: URLSearchParams) {
  const windowLabel = params.get("window") ?? "settings";
  const scenario = findScenario(windowLabel, params.get("mock") ?? "default");
  const db = createDb();
  scenario.setup?.(db);
  db.anchor = parseAnchor(params.get("anchor"));
  if (params.get("style") === "compact") db.settings.panelStyle = "compact";
  // 静止状態のシナリオは確定結果・エラー表示を消さない
  devOverrides.holdResults = !scenario.live;
  const step = Number(params.get("step")) || scenario.step || null;
  devOverrides.setupStep = step;

  mockWindows(windowLabel, "panel", "settings", "setup");
  const slow = new Set(params.get("slow")?.split(",").filter(Boolean) ?? []);

  let scriptStarted = false;
  let levelTimer: ReturnType<typeof setInterval> | null = null;
  let provisioningTimer: ReturnType<typeof setInterval> | null = null;

  // Rust と同じく状態を変えるたびに seq を増やす
  const setStatus = (patch: Partial<Omit<AppStatus, "seq">>) => {
    db.status = { ...db.status, ...patch, seq: db.status.seq + 1 };
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
    windowCalls: [],
    fail: {},
    invoke: (cmd, args) => invoke(cmd, args),
    setStatus,
    fire,
    started: (id) => fire("utterance-started", { id }),
    partial: (u: Utterance) => fire("utterance-partial", u),
    result: (r: UtteranceResult) => fire("utterance-result", r),
    setAnchor: (anchor: PanelAnchor) => {
      db.anchor = anchor;
      fire("panel-anchor", anchor);
    },
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

  // Rust の provisioning を模す: runtime (約1秒) → model (0.1 GB / 250ms、最初の約2秒は残り時間 null) → verify (約1秒) → done。
  // verify の後、Rust は起動したサーバーをそのまま使うため status は loading → off になる
  let stageTicks = 0;
  const setProvisioning = (p: ProvisioningStatus) => {
    db.provisioning = p;
    fire("provisioning-progress", p);
  };
  const stopProvisioningTicker = () => {
    if (provisioningTimer) clearInterval(provisioningTimer);
    provisioningTimer = null;
  };
  const startProvisioningTicker = () => {
    if (provisioningTimer) return;
    provisioningTimer = setInterval(() => {
      const p = db.provisioning;
      stageTicks += 1;
      const modelDone = p.items[1].bytesDone;
      if (p.stage === "runtime") {
        if (stageTicks >= 4) {
          stageTicks = 0;
          setProvisioning(provisioning("model", { modelDone, eta: null }));
        }
      } else if (p.stage === "model") {
        const next = Math.min(MODEL_TOTAL, modelDone + 0.1 * GB);
        if (next >= MODEL_TOTAL) {
          stageTicks = 0;
          setProvisioning(provisioning("verify"));
          setStatus({ phase: "loading", loadingProgress: null, error: null });
        } else {
          const eta = stageTicks < 8 ? null : Math.round(((MODEL_TOTAL - next) / (0.1 * GB)) * 0.25);
          setProvisioning(provisioning("model", { modelDone: next, eta }));
        }
      } else if (p.stage === "verify") {
        if (stageTicks >= 4) {
          stopProvisioningTicker();
          setProvisioning(provisioning("done"));
          // セットアップは選択中のモデルを取得する
          setModels(
            db.models.map((m) =>
              m.selected ? model(m.id as ModelId, "downloaded", { selected: true }) : m,
            ),
          );
          setStatus({ phase: "off", loadingProgress: null, error: null });
        }
      } else {
        stopProvisioningTicker();
      }
    }, 250);
  };

  // Rust のモデルの管理を模す: 取得は 0.1 GB / 250ms (最初の約2秒は残り時間 null)、同時に取得するのは1つ。
  // 選択は loading を経由して約1秒で準備完了 (db.modelSelectFail があれば元のモデルに戻して reject)
  let modelTimer: ReturnType<typeof setInterval> | null = null;
  let modelTicks = 0;
  let switching = false;
  // 未取得・未選択に戻った旧候補は一覧から消える (Rust の list_models と同じ規則)
  const setModels = (next: ModelInfo[]) => {
    db.models = visibleModels(next);
    fire("models-changed", db.models);
  };
  const patchModel = (id: string, patch: Partial<ModelInfo>) =>
    setModels(db.models.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  const resetModel = (id: string) =>
    setModels(db.models.map((m) => (m.id === id ? model(m.id as ModelId, "not_downloaded", { selected: m.selected }) : m)));
  const findModel = (id: unknown): ModelInfo => {
    const m = db.models.find((x) => x.id === id);
    if (!m) throw "不明なモデルです";
    return m;
  };
  // Rust は reject の値に表示用の文字列を返す
  const requireModelOps = () => {
    if (db.provisioning.stage !== "done") throw "セットアップが完了していません";
  };
  const stopModelTicker = () => {
    if (modelTimer) clearInterval(modelTimer);
    modelTimer = null;
  };
  const startModelTicker = (id: string) => {
    stopModelTicker();
    modelTicks = 0;
    modelTimer = setInterval(() => {
      const m = db.models.find((x) => x.id === id);
      if (!m || m.state !== "downloading") return stopModelTicker();
      modelTicks += 1;
      const next = Math.min(m.sizeBytes, m.bytesDone + 0.1 * GB);
      if (next >= m.sizeBytes) {
        stopModelTicker();
        patchModel(id, { state: "downloaded", bytesDone: m.sizeBytes, diskBytes: m.sizeBytes, etaSeconds: null });
        return;
      }
      const eta = modelTicks < 8 ? null : Math.round(((m.sizeBytes - next) / (0.1 * GB)) * 0.25);
      patchModel(id, { bytesDone: next, diskBytes: next, etaSeconds: eta });
    }, 250);
  };

  mockIPC(
    async (cmd, args) => {
      const a = (args ?? {}) as Record<string, unknown>;
      if (!cmd.startsWith("plugin:")) api.calls.push({ cmd, args: a });
      else if (cmd.startsWith("plugin:window|")) api.windowCalls.push({ cmd, args: a });
      const failure = api.fail[cmd];
      if (failure != null) return Promise.reject(failure);
      if (slow.has(cmd)) {
        // 応答時点の値ではなく、呼ばれた時点の値を返す (遅れて届く古い応答を再現する)
        const snapshot = cmd === "get_status" ? db.status : cmd === "get_panel_anchor" ? db.anchor : undefined;
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
            if (pane === "login_items") return;
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
        case "start_provisioning": {
          // 実行中・完了済みなら何もしない。一時停止・失敗からは止まった段階から続ける (model は取得済みの分から)
          const p = db.provisioning;
          if (p.stage !== "idle" && p.stage !== "paused" && p.stage !== "error") return null;
          const at = p.items.find((i) => i.state === "active")?.id ?? "runtime";
          stageTicks = 0;
          setProvisioning(provisioning(at, { modelDone: p.items[1].bytesDone, eta: null }));
          startProvisioningTicker();
          return null;
        }
        case "pause_provisioning": {
          const p = db.provisioning;
          if (p.stage !== "runtime" && p.stage !== "model" && p.stage !== "verify") return null;
          stopProvisioningTicker();
          // Rust は実際に止まってから返る。止まるまでの間を再現する
          await new Promise((r) => setTimeout(r, 300));
          setProvisioning(provisioning("paused", { stoppedAt: p.stage, modelDone: p.items[1].bytesDone }));
          return null;
        }
        case "get_storage_usage":
          return db.provisioning.stage === "done"
            ? {
                runtimeBytes: 1.2 * GB,
                modelBytes: db.models.reduce((sum, m) => sum + m.diskBytes, 0),
                otherBytes: 12_000_000,
              }
            : { runtimeBytes: 0, modelBytes: 0, otherBytes: 12_000_000 };
        case "delete_runtime_and_model":
          await new Promise((r) => setTimeout(r, 300));
          stopProvisioningTicker();
          stopModelTicker();
          setProvisioning(provisioning("idle"));
          // 全モデルを消し、選択は既定に戻る
          setModels(db.models.map((m) => model(m.id as ModelId, "not_downloaded", { selected: m.recommended })));
          setStatus({ phase: "error", loadingProgress: null, error: RUNTIME_MISSING });
          return null;
        case "list_models":
          return visibleModels(db.models);
        case "select_model": {
          requireModelOps();
          const m = findModel(a.id);
          if (switching) throw "モデルを切り替え中です";
          if (m.selected) return null;
          if (m.state !== "downloaded") throw "ダウンロードが済んでいないモデルは選べません";
          switching = true;
          // Rust は新しいモデルで ASR を起動し直し (音声入力は OFF、phase は loading を経由)、
          // 準備完了してから選択を記録する。失敗したら選択は元のまま
          setStatus({ phase: "loading", loadingProgress: null, error: null });
          await new Promise((r) => setTimeout(r, 1000));
          const failure = db.modelSelectFail;
          if (failure == null) {
            setModels(db.models.map((x) => ({ ...x, selected: x.id === m.id })));
          }
          setStatus({ phase: "off", loadingProgress: null, error: null });
          switching = false;
          if (failure != null) throw failure;
          return null;
        }
        case "download_model": {
          requireModelOps();
          const m = findModel(a.id);
          if (m.state === "downloaded" || m.state === "downloading") return null;
          if (db.models.some((x) => x.state === "downloading")) throw "他のモデルをダウンロード中です";
          patchModel(m.id, { state: "downloading", etaSeconds: null, error: null });
          startModelTicker(m.id);
          return null;
        }
        case "pause_model_download": {
          // Rust は止めるだけのため、セットアップ未完了・削除の実行中でも拒まない
          const m = findModel(a.id);
          if (m.state !== "downloading") return null;
          stopModelTicker();
          // Rust は実際に止まってから返る
          await new Promise((r) => setTimeout(r, 300));
          patchModel(m.id, { state: "paused", etaSeconds: null });
          return null;
        }
        case "cancel_model_download": {
          requireModelOps();
          const m = findModel(a.id);
          if (m.state === "downloaded") throw "ダウンロード済みです";
          if (m.state === "downloading") stopModelTicker();
          await new Promise((r) => setTimeout(r, 200));
          resetModel(m.id);
          return null;
        }
        case "delete_model": {
          requireModelOps();
          const m = findModel(a.id);
          if (switching) throw "モデルを切り替え中です";
          if (m.selected) throw "使用中のモデルは削除できません";
          if (m.state === "downloading") throw "ダウンロード中のモデルは削除できません。中止してください";
          await new Promise((r) => setTimeout(r, 300));
          resetModel(m.id);
          return null;
        }
        case "get_uninstall_targets":
          return [
            // Rust は存在するものだけを絶対パスで返す
            { path: "/Applications/mukuchi.app", bytes: 48_000_000 },
            { path: `${HOME}/Library/Application Support/com.minimalcorp.mukuchi`, bytes: 3.6 * GB },
            { path: `${HOME}/Library/Caches/com.minimalcorp.mukuchi`, bytes: 21_000_000 },
            { path: `${HOME}/Library/Logs/com.minimalcorp.mukuchi`, bytes: 12_000_000 },
            { path: `${HOME}/Library/WebKit/com.minimalcorp.mukuchi`, bytes: 2_000_000 },
            { path: `${HOME}/Library/Preferences/com.minimalcorp.mukuchi.plist`, bytes: 4_000 },
          ];
        case "uninstall":
          // 実機は成功するとアプリが終了する。モックは MUKUCHI_DEV_UNINSTALL_DRY_RUN と同じく終了せずに返る
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
        case "show_panel":
        case "show_panel_menu":
          return null;
        case "get_panel_anchor":
          return db.anchor;
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
  /** ウィンドウ API の呼び出し (plugin:window|start_dragging 等)。Playwright から確認する */
  windowCalls: { cmd: string; args: Record<string, unknown> }[];
  /** command 名 → reject するメッセージ (Rust の表示用メッセージの代わり) */
  fail: Record<string, string>;
  /** Tauri の invoke (他ウィンドウからの command 呼び出しを再現する) */
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  setStatus: (patch: Partial<Omit<AppStatus, "seq">>) => void;
  fire: typeof fire;
  started: (id: number) => void;
  partial: (u: Utterance) => void;
  result: (r: UtteranceResult) => void;
  setLevel: (level: number, speech?: boolean) => void;
  /** Rust がドラッグ等でアンカーを変えた時の panel-anchor を再現する */
  setAnchor: (anchor: PanelAnchor) => void;
  typeIntoFocused: (text: string) => void;
};
