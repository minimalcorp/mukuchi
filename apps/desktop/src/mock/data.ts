/* モックの初期データ */
import type {
  AppStatus,
  Locale,
  AudioDevice,
  AudioLevel,
  GpuStatus,
  ModelInfo,
  PanelAnchor,
  Permissions,
  ProvisioningStatus,
  Settings,
  ShortcutStatus,
  UpdateStatus,
} from "@/lib/ipc";
import type { PerOs, Platform } from "@/lib/platform";
import type { MockApi } from "./index";
import { MOCK_SPEECH_TEXTS, MOCK_UI_TEXTS, MOCK_WINDOWS_TEXTS, mockVoiceCommands } from "./texts";

export type MockDb = {
  /** OS の言語 (uiLanguage が system の時の表示言語)。?locale= で指定する */
  systemLocale: Locale;
  /** OS (get_app_info の platform)。?platform= で指定する */
  platform: Platform;
  /** GPU の判定結果 (get_gpu_status。Windows のみ意味がある)。?gpu= で指定する */
  gpu: GpuStatus;
  /** probe_gpu (再検出) で見つかる判定結果。null なら今と同じ。?gpu-probe= で指定する */
  gpuProbe: GpuStatus["kind"] | null;
  status: AppStatus;
  settings: Settings;
  permissions: Permissions;
  provisioning: ProvisioningStatus;
  /** モデルの状態。list_models・models-changed は presentModels で表示言語・話す言語に合わせて返す */
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

/** 新規の設定 (Rust の既定と同じ)。speechLanguage は解決した表示言語、既定の音声コマンドは話す言語のもの */
function defaultSettings(locale: Locale, platform: Platform): Settings {
  const sp = MOCK_SPEECH_TEXTS[locale];
  const win = platform === "windows" ? MOCK_WINDOWS_TEXTS[locale] : null;
  return {
    launchAtLogin: true,
    inputDeviceId: null,
    vadSensitivity: 60,
    silenceMs: 1300,
    voiceCommandsEnabled: true,
    voiceCommands: mockVoiceCommands(locale, platform),
    asrContext: sp.asrContext,
    // Windows の識別子は実行ファイル名 (小文字)
    excludedApps: win
      ? [
          { bundleId: "1password.exe", name: "1Password" },
          { bundleId: "windowsterminal.exe", name: win.terminal },
        ]
      : [
          { bundleId: "com.1password.1password", name: "1Password" },
          { bundleId: "com.apple.Terminal", name: sp.terminal },
        ],
    panelPosition: null,
    setupCompleted: true,
    panelStyle: "full",
    inputMode: "continuous",
    autoSubmit: false,
    autoSubmitKey: "enter",
    autoCheckUpdates: true,
    // 既定は Mac・Windows とも Alt+Space (src-tauri/src/settings.rs の DEFAULT_SHORTCUT)
    shortcut: "Alt+Space",
    uiLanguage: "system",
    speechLanguage: locale,
    cpuInferenceAccepted: false,
  };
}

export const GB = 1_000_000_000;

export const MODEL_TOTAL = 2.4 * GB;

/**
 * カタログ (Rust の provisioning/models.rs の CATALOG と同じ値)。名前・説明は表示言語ごと (texts.ts)。
 * OS ごとの候補 (Mac = MLX、Windows = GGUF)。Windows の容量は HF 公開前の目安
 */
const CATALOG = [
  { id: "ja-8bit", sizeBytes: 2_185_804_096, tunedFor: "ja", legacy: false },
  { id: "base-1.7b-8bit", sizeBytes: 2_174_372_462, tunedFor: null, legacy: false },
  // 旧候補: 手元にある時だけ一覧に出る (docs/architecture.md「モデルの管理」の旧候補)
  { id: "ja-bf16", sizeBytes: 4_092_092_275, tunedFor: "ja", legacy: true },
  { id: "ja-gguf", sizeBytes: 2_190_000_000, tunedFor: "ja", legacy: false },
  { id: "base-gguf", sizeBytes: 2_520_000_000, tunedFor: null, legacy: false },
] as const satisfies readonly { id: string; sizeBytes: number; tunedFor: Locale | null; legacy: boolean }[];

export type ModelId = (typeof CATALOG)[number]["id"];

/** 話す言語ごとの並び (Rust の MODEL_ORDER)。先頭が推奨 */
export const MODEL_ORDER: Record<Locale, ModelId[]> = {
  ja: ["ja-8bit", "base-1.7b-8bit"],
  en: ["base-1.7b-8bit", "ja-8bit"],
};

/** OS ごとの並び (Windows は GGUF の候補。Mac は MODEL_ORDER) */
const MODEL_ORDERS: PerOs<Record<Locale, ModelId[]>> = {
  macos: MODEL_ORDER,
  windows: { ja: ["ja-gguf", "base-gguf"], en: ["base-gguf", "ja-gguf"] },
};

export function modelOrder(platform: Platform, speech: Locale): ModelId[] {
  return MODEL_ORDERS[platform][speech];
}

/** 解決した表示言語 (Rust の get_locale)。system は OS の言語 (モックでは ?locale=) */
export function resolvedLocale(db: MockDb): Locale {
  return db.settings.uiLanguage === "system" ? db.systemLocale : db.settings.uiLanguage;
}

/**
 * Rust の list_models と同じ形にする: 旧候補は選択中か手元にある時だけ出し (not_downloaded かつ未選択なら除く)、
 * 名前・説明は表示言語、推奨は話す言語の先頭、並びは話す言語の順 (旧候補・カタログにない id は末尾)。
 * カタログにない id (テストで足した行) はそのまま出す
 */
export function presentModels(db: MockDb, models: ModelInfo[] = db.models): ModelInfo[] {
  const order = MODEL_ORDERS[db.platform][db.settings.speechLanguage] ?? MODEL_ORDERS[db.platform].ja;
  const texts = MOCK_UI_TEXTS[resolvedLocale(db)].models;
  const rank = (id: string) => {
    const i = order.indexOf(id as ModelId);
    return i < 0 ? order.length : i;
  };
  return models
    .filter((m) => !(CATALOG.find((c) => c.id === m.id)?.legacy && m.state === "not_downloaded" && !m.selected))
    .map((m) => {
      const c = CATALOG.find((x) => x.id === m.id);
      if (!c) return m;
      // 取得の失敗の文言 (モックの既定) も表示言語にする
      const failed = Object.values(MOCK_UI_TEXTS).some((x) => x.modelDownloadFailed === m.error);
      return {
        ...m,
        ...texts[c.id],
        tunedFor: c.tunedFor,
        recommended: order[0] === c.id,
        error: failed ? MOCK_UI_TEXTS[resolvedLocale(db)].modelDownloadFailed : m.error,
      };
    })
    .sort((x, y) => rank(x.id) - rank(y.id));
}

/**
 * Rust と同じ形の ModelInfo を作る。bytesDone は downloading・paused・error の時だけ使う
 * (downloaded は sizeBytes、not_downloaded は 0)。diskBytes は手元のファイルの量。
 * 名前・説明・推奨は presentModels が表示言語・話す言語に合わせて入れ直す
 */
export function model(
  id: ModelId,
  state: ModelInfo["state"],
  opts: { selected?: boolean; bytesDone?: number; eta?: number | null; error?: string } = {},
): ModelInfo {
  const { sizeBytes, tunedFor } = CATALOG.find((m) => m.id === id)!;
  const bytesDone =
    state === "downloaded" ? sizeBytes : state === "not_downloaded" ? 0 : (opts.bytesDone ?? 0.9 * GB);
  return {
    id,
    ...MOCK_UI_TEXTS.ja.models[id],
    tunedFor,
    sizeBytes,
    recommended: id === MODEL_ORDER.ja[0],
    selected: opts.selected ?? false,
    state,
    bytesDone,
    etaSeconds: state === "downloading" ? (opts.eta === undefined ? 180 : opts.eta) : null,
    error: state === "error" ? (opts.error ?? MOCK_UI_TEXTS.ja.modelDownloadFailed) : null,
    diskBytes: bytesDone,
  };
}

/** 新規の導入の一覧: 話す言語の推奨を選択中 (state は引数)、他は未取得 */
export function defaultModels(
  speech: Locale,
  selectedState: ModelInfo["state"] = "downloaded",
  platform: Platform = "macos",
): ModelInfo[] {
  const order = modelOrder(platform, speech);
  return order.map((id, i) => (i === 0 ? model(id, selectedState, { selected: true }) : model(id, "not_downloaded")));
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
  opts: { modelDone?: number; stoppedAt?: ItemId; eta?: number | null; locale?: Locale } = {},
): ProvisioningStatus {
  const { modelDone = 0.9 * GB, stoppedAt = "model", eta = 180, locale = "ja" } = opts;
  const tx = MOCK_UI_TEXTS[locale];
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
          ? tx.modelDownloadFailed
          : stoppedAt === "runtime"
            ? tx.runtimeFailed
            : tx.verifyFailed
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

/** GPU の判定結果 (Rust と同じ形)。accepted: CPU 実行に同意済み (GPU を使えない時は CPU で動かす) */
export function gpuStatus(kind: GpuStatus["kind"], accepted = false): GpuStatus {
  switch (kind) {
    case "ok":
      return {
        kind,
        devices: [{ name: "NVIDIA GeForce RTX 3080 Ti", vramMb: 12288, integrated: false }],
        selected: "NVIDIA GeForce RTX 3080 Ti",
        device: "gpu",
      };
    case "integrated":
      return {
        kind,
        devices: [{ name: "Intel(R) UHD Graphics 770", vramMb: null, integrated: true }],
        selected: "Intel(R) UHD Graphics 770",
        device: "gpu",
      };
    default:
      return { kind, devices: [], selected: null, device: accepted ? "cpu" : "gpu" };
  }
}

export function createDb(locale: Locale, platform: Platform = "macos"): MockDb {
  const settings = defaultSettings(locale, platform);
  const sp = MOCK_SPEECH_TEXTS[locale];
  const win = platform === "windows" ? MOCK_WINDOWS_TEXTS[locale] : null;
  return {
    systemLocale: locale,
    platform,
    // Mac の get_gpu_status は常に ok (GPU の名前は返さない)
    gpu: platform === "windows" ? gpuStatus("ok") : { kind: "ok", devices: [], selected: null, device: "gpu" },
    gpuProbe: null,
    status: { phase: "off", loadingProgress: null, error: null, seq: 0 },
    settings,
    permissions: { microphone: "granted", accessibility: true },
    provisioning: provisioning("done", { locale }),
    // 新規の導入: 話す言語の推奨を取得済み・選択中。旧候補 (bf16) は出ない
    models: defaultModels(locale, "downloaded", platform),
    shortcut: { shortcut: settings.shortcut, registered: true, error: null },
    shortcutSuspended: false,
    // エラー表示の確認用。実機で何が拒否されるかは OS 次第 (他アプリと同じキーでも登録は成功しうる)
    shortcutRejected: ["Cmd+Space", "Ctrl+Space"],
    modelSelectFail: null,
    level: { level: 0.18, threshold: 0.55, speech: false },
    devices: [
      { id: "builtin", name: win?.builtInMic ?? sp.builtInMic, isDefault: true },
      { id: "airpods", name: "AirPods Pro", isDefault: false },
      { id: "usb", name: sp.usbMic, isDefault: false },
    ],
    anchor: { horizontal: "center", vertical: "bottom" },
    update: updateStatus("idle"),
    updateLatest: null,
    updateInstallError: null,
    levelStream: false,
    onListen: null,
  };
}
