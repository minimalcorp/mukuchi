/*
 * モックのシナリオ。URL の ?window=<panel|settings|setup>&mock=<名前> で選ぶ。
 * setup は &step=<1-6>、settings は &category=<カテゴリ> も併用できる。&locale=<ja|en> で OS の言語 (index.ts)。
 * 発話・アプリ名は話す言語 (MOCK_SPEECH_TEXTS)、Rust の文言は表示言語 (MOCK_UI_TEXTS) で作る。
 */
import type { AppError, AppErrorAction, AppErrorCode, AppStatus, Locale } from "@/lib/ipc";
import type { MockApi } from "./index";
import {
  GB,
  MODEL_ORDER,
  UPDATE_TOTAL,
  defaultModels,
  model,
  provisioning,
  resolvedLocale,
  updateStatus,
  type MockDb,
} from "./data";
import { MOCK_SPEECH_TEXTS, MOCK_UI_TEXTS } from "./texts";

export type Scenario = {
  name: string;
  description: string;
  /** true: 時間経過で状態が進む (結果表示も時間経過で消える) */
  live?: boolean;
  /** setup の初期ステップ (1-6) */
  step?: number;
  setup?: (db: MockDb) => void;
  script?: (api: MockApi) => void;
};

const THRESHOLD = 0.55;

/** 話す言語の発話・アプリ名 */
const sp = (db: MockDb) => MOCK_SPEECH_TEXTS[db.settings.speechLanguage] ?? MOCK_SPEECH_TEXTS.ja;
/** 表示言語の Rust の文言 */
const ui = (db: MockDb) => MOCK_UI_TEXTS[resolvedLocale(db)];
/** もう一方の言語 (話す言語と推奨モデルが食い違う状態を作る) */
const otherLocale = (l: Locale): Locale => (l === "ja" ? "en" : "ja");

/** シナリオの初期状態。Rust と同じく状態を変えるたびに seq を増やす */
const setStatus = (db: MockDb, s: Omit<AppStatus, "seq">) => {
  db.status = { ...s, seq: db.status.seq + 1 };
};

const listening = (db: MockDb, level = 0.18) => {
  setStatus(db, { phase: "listening", loadingProgress: null, error: null });
  db.level = { level, threshold: THRESHOLD, speech: level >= THRESHOLD };
};

const ERRORS: Record<string, { code: AppErrorCode; action: AppErrorAction }> = {
  accessibility: { code: "accessibility_denied", action: "open_accessibility" },
  asr: { code: "asr_stopped", action: "restart_asr" },
  mic: { code: "microphone_missing", action: "select_microphone" },
  "mic-denied": { code: "microphone_denied", action: "open_microphone" },
  runtime: { code: "runtime_missing", action: "start_setup" },
};

/** Rust と同じく message は表示言語 */
const errorOf = (db: MockDb, key: string): AppError => ({ ...ERRORS[key], message: ui(db).errors[ERRORS[key].code] });

const errorScenario = (key: string): Scenario => ({
  name: `error-${key}`,
  description: `エラー: ${ERRORS[key].code}`,
  setup: (db) => {
    setStatus(db, { phase: "error", loadingProgress: null, error: errorOf(db, key) });
  },
});

/** 発話 → 途中表示 → 確定 → 入力 を繰り返す (live) */
function liveLoop(api: MockApi) {
  const t = sp(api.db);
  const sentences = [
    { text: t.text, app: t.notes },
    { text: t.command, command: "Enter" },
    { text: t.second, app: "Slack" },
  ];
  let id = 100;
  let i = 0;
  const run = () => {
    if (api.db.status.phase === "off") return;
    const s = sentences[i % sentences.length];
    i += 1;
    id += 1;
    const myId = id;
    api.setLevel(0.72, true);
    api.setStatus({ phase: "speaking" });
    api.started(myId);
    const steps = Math.max(1, Math.ceil(s.text.length / 5));
    for (let k = 1; k <= steps; k++) {
      setTimeout(() => {
        const text = s.text.slice(0, Math.min(s.text.length, k * 5));
        api.partial({ id: myId, text, stableLength: Math.max(0, text.length - 4) });
      }, k * 400);
    }
    const endAt = steps * 400 + 500;
    setTimeout(() => {
      api.setLevel(0.06);
      api.setStatus({ phase: "finalizing" });
    }, endAt);
    setTimeout(() => {
      if (s.command) api.result({ kind: "command", id: myId, text: s.text, key: s.command });
      else api.result({ kind: "inserted", id: myId, text: s.text, appName: s.app ?? t.notes, submitted: false });
      api.setLevel(0.12);
      api.setStatus({ phase: "listening" });
    }, endAt + 700);
    setTimeout(run, endAt + 700 + 3200);
  };
  setTimeout(run, 1200);
}

/**
 * プレビューの差分表示を順に見せる途中表示 (前回からの変化)。最後の要素は確定結果。
 * 色付けが白へ戻りきるのを見られるよう、1 段ずつ間を空けて流す
 */
export const PREVIEW_DIFF_STEPS = [
  "明日の打ち合わせは", // 最初の表示 (色付けしない)
  "明日の打ち合わせは十時から", // 末尾への追加 (色付けしない)
  "明日の打ち合わせは十一時から", // 途中の書き換え (黄)
  "明日の午後の打ち合わせは十一時から", // 途中への挿入 (緑)
  "明日の午後の打ち合わせは十一時からへんこう", // 末尾への追加 (色付けしない)
  "明日の午後の打ち合わせは十一時からに変更して", // 末尾の書き換え + 追加 (末尾全体を黄)
  "明日の午後の打ち合わせは、十一時からに変更してください。", // 確定で読点の挿入 (緑) と末尾の追加
];

/** PREVIEW_DIFF_STEPS を途中表示 → 確定の順に繰り返し流す (live) */
function previewDiffLoop(api: MockApi) {
  const STEP_MS = 1400;
  let id = 200;
  const run = () => {
    if (api.db.status.phase === "off") return;
    id += 1;
    const myId = id;
    api.setLevel(0.72, true);
    api.setStatus({ phase: "speaking" });
    api.started(myId);
    const partials = PREVIEW_DIFF_STEPS.slice(0, -1);
    partials.forEach((text, k) => {
      // stableLength は表示に使わないが、Rust と同じく前回との共通接頭辞の長さを入れる
      const prev = partials[k - 1] ?? "";
      let common = 0;
      while (common < prev.length && prev[common] === text[common]) common++;
      setTimeout(() => api.partial({ id: myId, text, stableLength: common }), k * STEP_MS);
    });
    const endAt = partials.length * STEP_MS;
    setTimeout(() => {
      api.setLevel(0.06);
      api.setStatus({ phase: "finalizing" });
    }, endAt - STEP_MS / 2);
    setTimeout(() => {
      const text = PREVIEW_DIFF_STEPS[PREVIEW_DIFF_STEPS.length - 1];
      api.result({ kind: "inserted", id: myId, text, appName: sp(api.db).notes, submitted: false });
      api.setLevel(0.12);
      api.setStatus({ phase: "listening" });
    }, endAt);
    setTimeout(run, endAt + 3000);
  };
  setTimeout(run, 800);
}

const PANEL: Scenario[] = [
  {
    name: "default",
    description: "操作できるデモ。「音声入力をオン」を押すと発話を流す",
    live: true,
    setup: (db) => {
      setStatus(db, { phase: "off", loadingProgress: null, error: null });
      db.levelStream = true;
      db.level = { level: 0.14, threshold: THRESHOLD, speech: false };
      db.onListen = liveLoop;
    },
  },
  {
    name: "preview-diff",
    description: "プレビューの差分表示 (書き換え・挿入・末尾の書き換え・確定での変化を繰り返す)",
    live: true,
    setup: (db) => {
      listening(db, 0.12);
      db.levelStream = true;
      db.onListen = previewDiffLoop;
    },
    script: previewDiffLoop,
  },
  { name: "off", description: "オフ" },
  {
    name: "loading",
    description: "モデル読み込み中 64%",
    setup: (db) => {
      setStatus(db, { phase: "loading", loadingProgress: 0.64, error: null });
    },
  },
  {
    name: "loading-indeterminate",
    description: "モデル読み込み中 (進捗不明)",
    setup: (db) => {
      setStatus(db, { phase: "loading", loadingProgress: null, error: null });
    },
  },
  { name: "idle", description: "オン・待機中 (しきい値未満)", setup: (db) => listening(db) },
  {
    name: "speaking",
    description: "発話中 (リアルタイムプレビュー)",
    setup: (db) => {
      listening(db, 0.72);
      db.status.phase = "speaking";
    },
    script: (api) => {
      api.started(1);
      const t = sp(api.db);
      api.partial({ id: 1, text: t.partial, stableLength: Math.max(0, t.partial.length - 5) });
    },
  },
  {
    name: "finalizing",
    description: "話し終わり (確定処理中)",
    setup: (db) => {
      listening(db, 0.06);
      db.status.phase = "speaking";
    },
    script: (api) => {
      api.started(1);
      const { text } = sp(api.db);
      api.partial({ id: 1, text, stableLength: text.length });
      api.setStatus({ phase: "finalizing" });
    },
  },
  {
    name: "inserted",
    description: "入力完了 (実機は 750ms 後にピルへ戻る)",
    setup: (db) => listening(db, 0.06),
    script: (api) => {
      api.started(1);
      api.result({ kind: "inserted", id: 1, text: sp(api.db).text, appName: sp(api.db).notes, submitted: false });
    },
  },
  {
    name: "command",
    description: "音声コマンド実行",
    setup: (db) => listening(db, 0.06),
    script: (api) => {
      api.started(1);
      api.result({ kind: "command", id: 1, text: sp(api.db).command, key: "Enter" });
    },
  },
  {
    name: "excluded",
    description: "入力しないアプリが前面",
    setup: (db) => listening(db, 0.06),
    script: (api) => {
      api.started(1);
      api.result({ kind: "skipped_excluded", id: 1, text: sp(api.db).text, appName: "1Password" });
    },
  },
  {
    name: "failed",
    description: "エラー (入力できなかった)",
    setup: (db) => listening(db, 0.06),
    script: (api) => {
      api.started(1);
      api.result({
        kind: "failed",
        id: 1,
        text: sp(api.db).text,
        error: {
          code: "accessibility_denied",
          message: ui(api.db).insertFailedNoAccessibility,
          action: "open_accessibility",
        },
      });
    },
  },
  {
    name: "multi",
    description: "前の発話の確定中に次の発話",
    setup: (db) => {
      listening(db, 0.66);
      db.status.phase = "speaking";
    },
    script: (api) => {
      const t = sp(api.db);
      api.started(1);
      api.partial({ id: 1, text: t.text, stableLength: t.text.length });
      api.started(2);
      api.partial({ id: 2, text: t.secondPartial, stableLength: 8 });
    },
  },
  {
    name: "overflow",
    description: "3 行を超えたプレビュー (古い行が上に送られる)",
    setup: (db) => {
      listening(db, 0.7);
      db.status.phase = "speaking";
    },
    script: (api) => {
      const t = sp(api.db);
      api.started(1);
      api.result({ kind: "inserted", id: 1, text: "1: " + t.text, appName: t.notes, submitted: false });
      api.started(2);
      api.partial({ id: 2, text: t.long, stableLength: 48 });
    },
  },
  errorScenario("accessibility"),
  errorScenario("asr"),
  errorScenario("mic"),
  errorScenario("mic-denied"),
  errorScenario("runtime"),
];

/** 起動時にショートカットを登録できなかった (Rust は設定を残したまま登録状態に error を入れる) */
function shortcutConflict(db: MockDb) {
  db.shortcut = {
    shortcut: db.settings.shortcut,
    registered: false,
    error: ui(db).shortcutConflict("⌥ Space"),
  };
}

/** セットアップ前の状態: モデルは話す言語の推奨を選択中・未取得 (取得前は話す言語の変更で選択が変わる) */
function freshSetup(db: MockDb) {
  db.provisioning = provisioning("idle");
  db.settings.setupCompleted = false;
  db.models = defaultModels(db.settings.speechLanguage, "not_downloaded");
}

const SETUP: Scenario[] = [
  {
    name: "default",
    description: "初回 (アクセシビリティ未許可・ダウンロード未開始)",
    live: true,
    setup: (db) => {
      db.permissions = { microphone: "not_determined", accessibility: false };
      freshSetup(db);
    },
  },
  {
    name: "welcome-running",
    step: 1,
    description: "ようこそ (実行環境の準備中に開き直した。話す言語は変えられない)",
    setup: (db) => {
      freshSetup(db);
      db.provisioning = provisioning("runtime");
    },
  },
  {
    name: "welcome-locked",
    step: 1,
    description: "ようこそ (モデルの取得を始めた後。話す言語は変えられない)",
    setup: (db) => {
      freshSetup(db);
      db.provisioning = provisioning("paused", { modelDone: 0.9 * GB });
    },
  },
  {
    name: "permissions",
    step: 2,
    description: "マイク許可済み・アクセシビリティ未許可",
    setup: (db) => {
      db.permissions = { microphone: "granted", accessibility: false };
    },
  },
  {
    name: "permissions-denied",
    step: 2,
    description: "マイク拒否済み",
    setup: (db) => {
      db.permissions = { microphone: "denied", accessibility: false };
    },
  },
  { name: "permissions-granted", step: 2, description: "両方許可済み" },
  {
    name: "download",
    step: 3,
    description: "モデルのダウンロード中 (静止)",
    setup: (db) => {
      db.provisioning = provisioning("model", { modelDone: 0.9 * GB });
    },
  },
  {
    name: "download-runtime",
    step: 3,
    description: "実行環境の導入中 (静止。モデルの大きさはまだ不明)",
    setup: (db) => {
      db.provisioning = provisioning("runtime");
    },
  },
  {
    name: "download-eta-unknown",
    step: 3,
    description: "モデルのダウンロード開始直後 (残り時間は未計算)",
    setup: (db) => {
      db.provisioning = provisioning("model", { modelDone: 0.1 * GB, eta: null });
    },
  },
  {
    name: "download-verify",
    step: 3,
    description: "動作確認中 (静止)",
    setup: (db) => {
      db.provisioning = provisioning("verify");
      setStatus(db, { phase: "loading", loadingProgress: null, error: null });
    },
  },
  {
    name: "download-live",
    step: 3,
    description: "ダウンロード中 (進む)",
    live: true,
    setup: (db) => {
      db.provisioning = provisioning("idle");
    },
  },
  {
    name: "download-error",
    step: 3,
    description: "モデルのダウンロード失敗 (取得済みの分から再開できる)",
    setup: (db) => {
      db.provisioning = provisioning("error", { modelDone: 0.9 * GB, locale: resolvedLocale(db) });
    },
  },
  {
    name: "download-error-runtime",
    step: 3,
    description: "実行環境の導入失敗",
    setup: (db) => {
      db.provisioning = provisioning("error", { stoppedAt: "runtime", locale: resolvedLocale(db) });
    },
  },
  {
    name: "download-paused",
    step: 3,
    description: "モデルのダウンロードを一時停止中",
    setup: (db) => {
      db.provisioning = provisioning("paused", { modelDone: 0.9 * GB });
    },
  },
  {
    name: "resume",
    description: "ウィンドウを開き直した (一時停止中。ダウンロードのステップから再開する)",
    setup: (db) => {
      db.provisioning = provisioning("paused", { modelDone: 0.9 * GB });
      db.settings.setupCompleted = false;
    },
  },
  { name: "download-done", step: 3, description: "ダウンロード完了" },
  { name: "input-mode", step: 4, description: "入力モードの選択 (既定の常に聞き取る)" },
  {
    name: "input-mode-oneshot",
    step: 4,
    description: "入力モードの選択 (1回ずつ聞き取るを選択済み)",
    setup: (db) => {
      db.settings.inputMode = "oneShot";
    },
  },
  {
    name: "input-mode-conflict",
    step: 4,
    description: "起動時にショートカットを登録できなかった",
    setup: shortcutConflict,
  },
  {
    name: "test",
    step: 5,
    description: "動作テスト (話した想定で入力と音声コマンドを流す)",
    setup: (db) => {
      listening(db, 0.46);
    },
    script: (api) => {
      const t = sp(api.db);
      setTimeout(() => {
        api.started(1);
        api.typeIntoFocused(t.testSentence);
        api.result({ kind: "inserted", id: 1, text: t.testSentence, appName: "mukuchi", submitted: false });
      }, 300);
      setTimeout(() => {
        api.started(2);
        api.typeIntoFocused("\n");
        api.result({ kind: "command", id: 2, text: t.command, key: "Enter" });
      }, 600);
    },
  },
  { name: "test-empty", step: 5, description: "動作テスト (まだ話していない)", setup: (db) => listening(db, 0.1) },
  {
    name: "test-oneshot",
    step: 5,
    description: "動作テスト (1回ずつ聞き取る。まだ話していない)",
    setup: (db) => {
      db.settings.inputMode = "oneShot";
    },
  },
  { name: "done", step: 6, description: "完了" },
  {
    name: "done-oneshot",
    step: 6,
    description: "完了 (1回ずつ聞き取る)",
    setup: (db) => {
      db.settings.inputMode = "oneShot";
    },
  },
];

const SETTINGS: Scenario[] = [
  { name: "default", description: "通常 (オン・待機中)", live: true, setup: (db) => { listening(db, 0.3); db.levelStream = true; } },
  { name: "shortcut-conflict", description: "起動時にショートカットを登録できなかった", setup: shortcutConflict },
  {
    name: "perm-denied",
    description: "アクセシビリティ未許可 (サイドバーに黄色の点)",
    setup: (db) => {
      db.permissions = { microphone: "granted", accessibility: false };
    },
  },
  {
    name: "mic-not-determined",
    description: "マイク未確認",
    setup: (db) => {
      db.permissions = { microphone: "not_determined", accessibility: true };
    },
  },
  {
    name: "loading",
    description: "モデル読み込み中",
    setup: (db) => {
      setStatus(db, { phase: "loading", loadingProgress: 0.64, error: null });
    },
  },
  {
    name: "asr-stopped",
    description: "文字起こしサーバー停止",
    setup: (db) => {
      setStatus(db, { phase: "error", loadingProgress: null, error: errorOf(db, "asr") });
    },
  },
  {
    name: "runtime-missing",
    description: "実行環境とモデルなし",
    setup: (db) => {
      setStatus(db, { phase: "error", loadingProgress: null, error: errorOf(db, "runtime") });
      db.provisioning = provisioning("idle");
    },
  },
  // ---- モデルの管理 (認識) ----
  // bf16 を含むものは旧版から bf16 を使っていた人の状態 (旧候補は手元にある時だけ出る)。
  // 話す言語の推奨 (先頭) が使用中で、もう一方は未取得の一覧に bf16 を足す。en では推奨が base-1.7b-8bit
  {
    name: "models-both",
    description: "モデル: 8bit と bf16 を取得済み (bf16 を使用中)",
    setup: (db) => {
      db.models = [model("ja-8bit", "downloaded"), model("base-1.7b-8bit", "not_downloaded"), model("ja-bf16", "downloaded", { selected: true })];
    },
  },
  {
    name: "models-legacy",
    description: "モデル: 推奨を使用中、bf16 (旧候補) も取得済み",
    setup: (db) => {
      db.models = [...defaultModels(db.settings.speechLanguage), model("ja-bf16", "downloaded")];
    },
  },
  {
    name: "models-downloading",
    description: "モデル: bf16 を取得中 (進捗は止まったまま)",
    setup: (db) => {
      db.models = [...defaultModels(db.settings.speechLanguage), model("ja-bf16", "downloading", { bytesDone: 1.5 * GB })];
    },
  },
  {
    name: "models-paused",
    description: "モデル: bf16 を一時停止",
    setup: (db) => {
      db.models = [...defaultModels(db.settings.speechLanguage), model("ja-bf16", "paused", { bytesDone: 1.5 * GB })];
    },
  },
  {
    name: "models-error",
    description: "モデル: bf16 の取得に失敗",
    setup: (db) => {
      db.models = [...defaultModels(db.settings.speechLanguage), model("ja-bf16", "error", { bytesDone: 1.5 * GB })];
    },
  },
  {
    name: "models-setup-incomplete",
    description: "モデル: セットアップ未完了 (操作不可)",
    setup: (db) => {
      db.provisioning = provisioning("paused");
      db.models = defaultModels(db.settings.speechLanguage, "paused");
    },
  },
  {
    name: "models-not-recommended",
    description: "モデル: 話す言語の推奨を使っていない (推奨は未取得。取得を案内する)",
    setup: (db) => {
      // もう一方の言語の推奨を使っている (話す言語を変えた後)
      db.models = defaultModels(otherLocale(db.settings.speechLanguage));
    },
  },
  {
    name: "models-not-recommended-downloaded",
    description: "モデル: 話す言語の推奨を取得済みだが使っていない (切り替えを案内する)",
    setup: (db) => {
      const [selected, rec] = MODEL_ORDER[otherLocale(db.settings.speechLanguage)];
      db.models = [model(selected, "downloaded", { selected: true }), model(rec, "downloaded")];
    },
  },
  // ---- アップデート (このアプリについて) ----
  {
    name: "update-unchecked",
    description: "アップデート: 未確認 (確認すると最新)",
    setup: (db) => {
      db.update = updateStatus("idle", { checkedAt: null });
    },
  },
  {
    name: "update-available",
    description: "アップデート: 未確認 (確認すると v0.2.0 を取得して ready)",
    setup: (db) => {
      db.update = updateStatus("idle", { checkedAt: null });
      db.updateLatest = "0.2.0";
    },
  },
  {
    name: "update-unavailable",
    description: "アップデート: dmg から起動 (確認できない)",
    setup: (db) => {
      db.update = updateStatus("unavailable", { error: ui(db).updateUnavailable });
    },
  },
  { name: "update-checking", description: "アップデート: 確認中", setup: (db) => { db.update = updateStatus("checking"); } },
  {
    name: "update-downloading",
    description: "アップデート: v0.2.0 を取得中 (進捗は止まったまま)",
    setup: (db) => {
      db.update = updateStatus("downloading", { bytesDone: 0.35 * UPDATE_TOTAL });
    },
  },
  {
    name: "update-ready",
    description: "アップデート: v0.2.0 の準備完了 (notes あり)",
    setup: (db) => {
      db.update = updateStatus("ready", {
        bytesDone: UPDATE_TOTAL,
        notes: ui(db).updateNotes,
      });
    },
  },
  { name: "update-installing", description: "アップデート: インストール中", setup: (db) => { db.update = updateStatus("installing"); } },
  {
    name: "update-error",
    description: "アップデート: 確認に失敗",
    setup: (db) => {
      db.update = updateStatus("error", { error: ui(db).updateError });
    },
  },
];

export const SCENARIOS: Record<string, Scenario[]> = { panel: PANEL, setup: SETUP, settings: SETTINGS };

export function findScenario(windowLabel: string, name: string): Scenario {
  const list = SCENARIOS[windowLabel] ?? [];
  return list.find((s) => s.name === name) ?? list[0] ?? { name: "default", description: "" };
}
