import { MODEL_SIZE, REQUIREMENTS, SETUP_DURATION, VERSION, PRICE } from "./site";

// 文言はデザイン (1b LP / 2a SP) のまま。lp-spec.md で直すと決めた箇所だけ変えている

export interface Feature {
  no: string;
  title: string;
  body: string;
  visual: "always" | "vad" | "command";
}

export const FEATURES: Feature[] = [
  {
    no: "01",
    visual: "always",
    title: "ローカルで動くから、常に起動しておける",
    body: "音声認識はすべて Mac 上で処理します。クラウドの利用料や回数の上限がないため、朝から晩までオンのままにしておけます。",
  },
  {
    no: "02",
    visual: "vad",
    title: "話した部分だけを、自動で入力",
    body: "発話の区間だけを検知して文字に起こし、カーソル位置に入力します。録音の開始・停止やホットキーの操作は不要です。黙っている間は何も入力しません。",
  },
  {
    no: "03",
    visual: "command",
    title: "キー操作も、声で",
    // lp-spec: アプリが未対応の「取り消し」を載せない
    body: "「確定」「改行」「送信」などの言葉を、対応するキー操作として実行します。AI エージェントへの指示やチャットの送信まで、キーボードに触れずに完結します。",
  },
];

export const ALWAYS_ROWS = [
  { icon: "wifi-off", k: "文字起こし時の通信", v: "0 件" },
  { icon: "infinity", k: "1 日あたりの利用上限", v: "なし" },
  { icon: "mouse-pointer-click", k: "入力開始に必要な操作", v: "なし" },
] as const;

// デザインの VAD の図の高さ (%)。発話区間は青で塗る
const VAD_PATTERN = [
  2, 3, 2, 4, 3, 2, 30, 70, 55, 90, 62, 80, 45, 72, 38, 3, 5, 2, 4, 3, 6, 2, 40, 85, 66, 92, 50, 76,
  58, 4, 2, 3, 10, 4, 2, 3, 60, 82, 48, 70, 3, 2, 4, 2, 3, 2,
];
const isSpeech = (i: number) => (i >= 6 && i <= 14) || (i >= 22 && i <= 28) || (i >= 36 && i <= 39);
export const VAD_BARS = VAD_PATTERN.map((h, i) => ({ h: Math.max(4, h), speech: isSpeech(i) }));

/** アプリの既定の音声コマンド (docs/architecture.md)。「確定」と「エンター」は同じ Enter */
export const COMMANDS = [
  { word: "確定", key: "Enter" },
  { word: "エンター", key: "Enter" },
  { word: "改行", key: "⇧ + Enter" },
  { word: "送信", key: "⌘ + Enter" },
];

export const PRIVACY = [
  { icon: "cpu", title: "端末内で文字起こし", body: "音声を外部のサーバーに送信しません。" },
  { icon: "trash-2", title: "録音を残さない", body: "音声は文字起こしが終わると破棄します。" },
  // 自動アップデートは未実装のため「アップデート」は書かない (lp-spec)
  { icon: "wifi-off", title: "通信はダウンロード時のみ", body: "モデルの取得以外に通信しません。" },
  { icon: "code-xml", title: "ソースコードを公開", body: "処理の内容は GitHub で確認できます。" },
] as const;

export const STEPS = [
  {
    no: "1",
    title: "ダウンロードしてインストール",
    body: "dmg を開き、mukuchi をアプリケーションフォルダに移動します。",
  },
  {
    no: "2",
    title: "権限を許可",
    body: "マイクとアクセシビリティの使用を許可します。アクセシビリティはほかのアプリへ入力するために使います。",
  },
  {
    no: "3",
    title: "音声認識モデルを取得",
    body: `初回起動時にモデル（${MODEL_SIZE}）をダウンロードします。完了するとメニューバーに常駐します。`,
  },
];

export const SETUP_LEAD = `アカウント登録は不要です。${SETUP_DURATION}で完了します。`;
export const REQUIREMENTS_LEAD = `標準モデルは ${REQUIREMENTS.model}です。今後のバージョンで、ほかの音声認識モデルも選べるようにする予定です。`;

export const REQUIREMENT_ROWS: { k: string; v: string; sub?: string }[] = [
  { k: "OS", v: REQUIREMENTS.os },
  { k: "チップ", v: REQUIREMENTS.chip, sub: REQUIREMENTS.chipVerified },
  { k: "メモリ", v: REQUIREMENTS.memory },
  { k: "ストレージ", v: REQUIREMENTS.storage },
  { k: "標準モデル", v: REQUIREMENTS.model },
  { k: "バージョン", v: VERSION },
  { k: "価格", v: PRICE },
];

export interface DemoStep {
  status: "待機中" | "認識中" | "入力しました" | "キー操作";
  speak?: boolean;
  preview?: string;
  input: string;
  sent: string[];
  caption: string;
  chip?: string;
  ms: number;
}

const L1 = "ログイン画面のバリデーションを見直してください。";
const L2 = "エラー文言も日本語にそろえてください。";

/** ヒーローのデモの流れ (デザインの script と同じ) */
export const DEMO_SCRIPT: DemoStep[] = [
  { status: "待機中", input: "", sent: [], caption: "起動中は常に発話を待っています", ms: 1800 },
  {
    status: "認識中",
    speak: true,
    preview: "ログイン画面のバリデーションを…",
    input: "",
    sent: [],
    caption: "発話を検知すると文字起こしを始めます",
    ms: 1800,
  },
  {
    status: "入力しました",
    input: L1,
    sent: [],
    caption: "話し終えると、カーソル位置に入力します",
    ms: 1600,
  },
  { status: "待機中", input: L1, sent: [], caption: "黙っている間は何も入力しません", ms: 1600 },
  {
    status: "認識中",
    speak: true,
    preview: "エラー文言も日本語にそろえて…",
    input: L1,
    sent: [],
    caption: "続けて話すと、そのまま追記します",
    ms: 1800,
  },
  {
    status: "入力しました",
    input: L1 + L2,
    sent: [],
    caption: "話し終えると、カーソル位置に入力します",
    ms: 1400,
  },
  {
    status: "認識中",
    speak: true,
    preview: "送信",
    input: L1 + L2,
    sent: [],
    caption: "",
    ms: 1000,
  },
  {
    status: "キー操作",
    chip: "「送信」→ ⌘ + Enter",
    input: "",
    sent: [L1 + L2],
    caption: "決まった言葉はキー操作として実行します",
    ms: 2600,
  },
];

/** 動きを減らす設定 (prefers-reduced-motion) の時に止めて見せる場面 (入力まで済んだ状態) */
export const DEMO_STILL_STEP = 5;
