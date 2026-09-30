/*
 * モックのシナリオ。URL の ?window=<panel|settings|setup>&mock=<名前> で選ぶ。
 * setup は &step=<1-5>、settings は &category=<カテゴリ> も併用できる。
 */
import type { AppError, AppStatus } from "@/lib/ipc";
import type { MockApi } from "./index";
import { GB, provisioning, type MockDb } from "./data";

export type Scenario = {
  name: string;
  description: string;
  /** true: 時間経過で状態が進む (結果表示も 2 秒で消える) */
  live?: boolean;
  /** setup の初期ステップ (1-5) */
  step?: number;
  setup?: (db: MockDb) => void;
  script?: (api: MockApi) => void;
};

const TEXT = "明日の打ち合わせは十時からに変更してください。";
const THRESHOLD = 0.55;

/** シナリオの初期状態。Rust と同じく状態を変えるたびに seq を増やす */
const setStatus = (db: MockDb, s: Omit<AppStatus, "seq">) => {
  db.status = { ...s, seq: db.status.seq + 1 };
};

const listening = (db: MockDb, level = 0.18) => {
  setStatus(db, { phase: "listening", loadingProgress: null, error: null });
  db.level = { level, threshold: THRESHOLD, speech: level >= THRESHOLD };
};

const ERRORS: Record<string, AppError> = {
  accessibility: {
    code: "accessibility_denied",
    message: "アクセシビリティが許可されていません",
    action: "open_accessibility",
  },
  asr: { code: "asr_stopped", message: "文字起こしサーバーが停止しました", action: "restart_asr" },
  mic: { code: "microphone_missing", message: "マイクが見つかりません", action: "select_microphone" },
  "mic-denied": { code: "microphone_denied", message: "マイクが許可されていません", action: "open_microphone" },
  runtime: { code: "runtime_missing", message: "実行環境とモデルがありません", action: "start_setup" },
};

const errorScenario = (key: string): Scenario => ({
  name: `error-${key}`,
  description: `エラー: ${ERRORS[key].code}`,
  setup: (db) => {
    setStatus(db, { phase: "error", loadingProgress: null, error: ERRORS[key] });
  },
});

/** 発話 → 途中表示 → 確定 → 入力 を繰り返す (live) */
function liveLoop(api: MockApi) {
  const sentences = [
    { text: TEXT, app: "メモ" },
    { text: "確定", command: "Enter" },
    { text: "資料は前日までに共有しておきます。", app: "Slack" },
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
      else api.result({ kind: "inserted", id: myId, text: s.text, appName: s.app ?? "メモ" });
      api.setLevel(0.12);
      api.setStatus({ phase: "listening" });
    }, endAt + 700);
    setTimeout(run, endAt + 700 + 3200);
  };
  setTimeout(run, 1200);
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
      api.partial({ id: 1, text: "明日の打ち合わせは十時からに変更して", stableLength: 13 });
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
      api.partial({ id: 1, text: TEXT, stableLength: TEXT.length });
      api.setStatus({ phase: "finalizing" });
    },
  },
  {
    name: "inserted",
    description: "入力完了 (実機は 2 秒後にピルへ戻る)",
    setup: (db) => listening(db, 0.06),
    script: (api) => {
      api.started(1);
      api.result({ kind: "inserted", id: 1, text: TEXT, appName: "メモ" });
    },
  },
  {
    name: "command",
    description: "音声コマンド実行",
    setup: (db) => listening(db, 0.06),
    script: (api) => {
      api.started(1);
      api.result({ kind: "command", id: 1, text: "確定", key: "Enter" });
    },
  },
  {
    name: "excluded",
    description: "入力しないアプリが前面",
    setup: (db) => listening(db, 0.06),
    script: (api) => {
      api.started(1);
      api.result({ kind: "skipped_excluded", id: 1, text: TEXT, appName: "1Password" });
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
        text: TEXT,
        error: {
          code: "accessibility_denied",
          message: "アクセシビリティが未許可のため入力できません",
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
      api.started(1);
      api.partial({ id: 1, text: TEXT, stableLength: TEXT.length });
      api.started(2);
      api.partial({ id: 2, text: "資料は前日までに共有して", stableLength: 8 });
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
      api.started(1);
      api.result({ kind: "inserted", id: 1, text: "一行目: " + TEXT, appName: "メモ" });
      api.started(2);
      api.partial({
        id: 2,
        text: "二行目以降: 会議室は三階の大会議室に変更になりました。参加者には別途連絡しますので、資料は前日までに共有してください",
        stableLength: 48,
      });
    },
  },
  errorScenario("accessibility"),
  errorScenario("asr"),
  errorScenario("mic"),
  errorScenario("mic-denied"),
  errorScenario("runtime"),
];

const SETUP: Scenario[] = [
  {
    name: "default",
    description: "初回 (アクセシビリティ未許可・ダウンロード未開始)",
    live: true,
    setup: (db) => {
      db.permissions = { microphone: "not_determined", accessibility: false };
      db.provisioning = provisioning("idle");
      db.settings.setupCompleted = false;
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
      db.provisioning = provisioning("error", { modelDone: 0.9 * GB });
    },
  },
  {
    name: "download-error-runtime",
    step: 3,
    description: "実行環境の導入失敗",
    setup: (db) => {
      db.provisioning = provisioning("error", { stoppedAt: "runtime" });
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
  {
    name: "test",
    step: 4,
    description: "動作テスト (話した想定で入力と音声コマンドを流す)",
    setup: (db) => {
      listening(db, 0.46);
    },
    script: (api) => {
      setTimeout(() => {
        api.started(1);
        api.typeIntoFocused("今日は晴れています。");
        api.result({ kind: "inserted", id: 1, text: "今日は晴れています。", appName: "mukuchi" });
      }, 300);
      setTimeout(() => {
        api.started(2);
        api.typeIntoFocused("\n");
        api.result({ kind: "command", id: 2, text: "確定", key: "Enter" });
      }, 600);
    },
  },
  { name: "test-empty", step: 4, description: "動作テスト (まだ話していない)", setup: (db) => listening(db, 0.1) },
  { name: "done", step: 5, description: "完了" },
];

const SETTINGS: Scenario[] = [
  { name: "default", description: "通常 (オン・待機中)", live: true, setup: (db) => { listening(db, 0.3); db.levelStream = true; } },
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
      setStatus(db, { phase: "error", loadingProgress: null, error: ERRORS.asr });
    },
  },
  {
    name: "runtime-missing",
    description: "実行環境とモデルなし",
    setup: (db) => {
      setStatus(db, { phase: "error", loadingProgress: null, error: ERRORS.runtime });
      db.provisioning = provisioning("idle");
    },
  },
];

export const SCENARIOS: Record<string, Scenario[]> = { panel: PANEL, setup: SETUP, settings: SETTINGS };

export function findScenario(windowLabel: string, name: string): Scenario {
  const list = SCENARIOS[windowLabel] ?? [];
  return list.find((s) => s.name === name) ?? list[0] ?? { name: "default", description: "" };
}
