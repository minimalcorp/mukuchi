import {
  DMG_SIZE,
  MODEL_NAME,
  MODEL_SIZE,
  PRICE,
  REQUIREMENTS,
  SETUP_DURATION,
  SHORTCUT,
  VERSION,
} from "./site";

// 文言はデザイン (mukuchi LP v2 の 1a PC / 1b SP) のまま。lp-spec.md で直すと決めた箇所だけ変えている

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
    body: "発話の区間だけを検知して文字に起こします。話している間はパネルにプレビューを表示し、話し終えるとカーソル位置に入力します。黙っている間や環境音では何も入力しません。",
  },
  {
    no: "03",
    visual: "command",
    title: "キー操作も、声で",
    body: "「確定」「改行」「送信」と話すと、対応するキー操作を実行します。発話全体が一致したときだけ実行するので、文中の言葉には反応しません。言葉とキーの組み合わせは設定で追加・編集・オフにできます。",
  },
];

export const ALWAYS_ROWS = [
  { icon: "wifi-off", k: "文字起こし時の通信", v: "0 件" },
  { icon: "infinity", k: "1 日あたりの利用上限", v: "なし" },
  // 「入力開始に必要な操作: なし」は 1回ずつ聞き取る (ショートカットで始める) と矛盾するため置き換えた
  { icon: "user-round", k: "アカウント登録", v: "不要" },
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

/** 特長のあとの「作業の邪魔をしないための機能」 */
export const EXTRAS = [
  {
    icon: "panel-top",
    title: "フォーカスを奪わないパネル",
    body: "通常表示と、マイクのボタンだけのコンパクト表示を選べます。ドラッグで移動でき、前面のアプリのフォーカスを奪いません。",
  },
  {
    icon: "app-window",
    title: "入力しないアプリ",
    body: "登録したアプリが前面にある間は、入力しません。",
  },
  {
    icon: "book-a",
    title: "語彙ヒント",
    body: "固有名詞などを登録しておくと、認識させやすくなります。",
  },
] as const;

export const PRIVACY = [
  { icon: "cpu", title: "端末内で文字起こし", body: "音声を外部のサーバーに送信しません。" },
  { icon: "trash-2", title: "録音を残さない", body: "音声を保存しません。" },
  // 自動アップデートは未実装のため「アップデート」は書かない (lp-spec)
  {
    icon: "wifi-off",
    title: "通信はモデルの取得時のみ",
    body: "音声認識モデルのダウンロード以外に通信しません。",
  },
  { icon: "code-xml", title: "ソースコードを公開", body: "処理の内容は GitHub で確認できます。" },
] as const;

export const STEPS = [
  {
    no: "1",
    title: "ダウンロードしてインストール",
    body: `dmg（約 ${DMG_SIZE}）を開き、mukuchi をアプリケーションフォルダに移動します。`,
  },
  {
    no: "2",
    title: "権限を許可",
    body: "マイクとアクセシビリティの使用を許可します。アクセシビリティはほかのアプリへ入力するために使います。",
  },
  {
    no: "3",
    title: "音声認識モデルを取得",
    body: `${MODEL_NAME}（${MODEL_SIZE}）をダウンロードします。`,
  },
  {
    no: "4",
    title: "入力モードとショートカットを選ぶ",
    body: `「常に聞き取る」か「1回ずつ聞き取る」を選び、ショートカット（既定は ${SHORTCUT}）を確認します。`,
  },
  { no: "5", title: "試しに話す", body: "実際に話して、入力されることを確認します。" },
];

export const SETUP_LEAD = `アカウント登録は不要です。モデルのダウンロードを含めて${SETUP_DURATION}で完了します。`;
export const REQUIREMENTS_LEAD = "Apple Silicon 搭載の Mac で動作します。";

export const REQUIREMENT_ROWS: { k: string; v: string }[] = [
  { k: "OS", v: REQUIREMENTS.os },
  { k: "チップ", v: REQUIREMENTS.chip },
  { k: "動作確認", v: REQUIREMENTS.chipVerified },
  { k: "メモリ", v: REQUIREMENTS.memory },
  { k: "ストレージ", v: REQUIREMENTS.storage },
  { k: "標準モデル", v: REQUIREMENTS.model },
  { k: "バージョン", v: VERSION },
  { k: "価格", v: PRICE },
];

// ---- 入力モード (desktop の Settings.inputMode。docs/architecture.md の「入力モード」) ----

export type InputMode = "always" | "once";

export const INPUT_MODES: readonly InputMode[] = ["always", "once"];

/** モード名。アプリの表示と同じ (「1回ずつ」は詰めて書く) */
export const MODE_NAMES: Record<InputMode, string> = {
  always: "常に聞き取る",
  once: "1回ずつ聞き取る",
};

// デザインの lead は「モードは初回セットアップで選びます。」だが、設定 > 音声入力 でも変えられるためそれも書く
export const MODES_LEAD =
  "既定は「常に聞き取る」です。周りに人がいるときや、入力するタイミングを自分で決めたいときは「1回ずつ聞き取る」を使います。モードは初回セットアップで選び、あとから設定で変更できます。";

export interface ModeCard {
  mode: InputMode;
  icon: "repeat" | "keyboard";
  isDefault: boolean;
  body: string;
  /** 波形の棒。h は高さ (%)、speech は発話 (青)、band は聞き取る区間 (背景を塗る) */
  bars: { h: number; speech: boolean; band: boolean }[];
  /** 波形の下の区間の説明。f は幅の比、t は PC・tSp はスマホの文言、active は聞き取る区間 */
  segs: { f: number; t: string; tSp: string; active: boolean }[];
  when: string[];
  /** ショートカットの動作。キーキャップの後に when、その右 (スマホは下) に does を書く */
  keys: { when: string; does: string }[];
}

// デザインの波形の高さ (%)。常に聞き取るは全体が聞き取る区間、1回ずつは押してから話し終わるまでだけ
const ALWAYS_WAVE = [
  3, 4, 3, 5, 3, 4, 40, 72, 55, 88, 62, 80, 45, 70, 4, 3, 5, 3, 4, 3, 50, 84, 66, 90, 58, 74, 40, 3,
  4, 3, 5, 4, 3, 62, 80, 48, 70, 4, 3, 3,
];
const alwaysSpeech = (i: number) =>
  (i >= 6 && i <= 13) || (i >= 20 && i <= 26) || (i >= 33 && i <= 36);
const ONCE_WAVE = [
  30, 52, 40, 60, 44, 36, 58, 30, 4, 3, 3, 4, 3, 40, 72, 55, 88, 62, 80, 45, 70, 66, 50, 4, 3, 3, 4,
  3, 34, 56, 42, 62, 38, 50, 30, 44, 4, 3, 4, 3,
];

export const MODE_CARDS: ModeCard[] = [
  {
    mode: "always",
    icon: "repeat",
    isDefault: true,
    body: "オンの間、話すたびに文字に起こして入力します。黙っている間は何も入力しません。",
    bars: ALWAYS_WAVE.map((h, i) => ({ h: Math.max(6, h), speech: alwaysSpeech(i), band: true })),
    segs: [{ f: 1, t: "オンの間、発話ごとに入力", tSp: "オンの間、発話ごとに入力", active: true }],
    when: ["ひとりで作業しているとき", "話すだけで次々に入力したいとき"],
    keys: [{ when: "を押す", does: "オン / オフを切り替えます" }],
  },
  {
    mode: "once",
    icon: "keyboard",
    isDefault: false,
    body: "ショートカットを押してから話し終わるまでを 1 回だけ文字にして入力し、自動でオフに戻ります。",
    // 押す前 (0〜7) の会話は聞き取らない。押してから (8〜) 話し終わる (22) までが 1 回分
    bars: ONCE_WAVE.map((h, i) => ({
      h: Math.max(6, h),
      speech: i >= 13 && i <= 22,
      band: i >= 8 && i <= 22,
    })),
    segs: [
      { f: 8, t: "オフ（会話は入力しない）", tSp: "オフ", active: false },
      { f: 15, t: `${SHORTCUT} → 1 回分を入力`, tSp: `${SHORTCUT} → 1 回分`, active: true },
      { f: 17, t: "自動でオフ", tSp: "自動でオフ", active: false },
    ],
    when: ["周りに人がいる・会話が聞こえる場所", "入力するタイミングを自分で決めたいとき"],
    // アプリの動作 (docs/architecture.md の「操作」「入力モード」)。10 秒はアプリ側の固定値
    keys: [
      { when: "を押す", does: "1 回分の聞き取りを始めます" },
      { when: "話す前にもう一度", does: "聞き取りを取り消します" },
      { when: "話している途中に", does: "無音を待たずに、その場で入力します" },
      { when: "のあと 10 秒", does: "話し始めなければ自動でオフに戻ります" },
    ],
  },
];

export const SHORTCUT_CALLOUT = {
  title: `どのアプリを使っていても、${SHORTCUT} で操作できます`,
  body: "押して離すだけで、押し続ける必要はありません。キーは設定で変更・無効化できます。パネルのボタンとメニューバーからも同じ操作ができます。",
};

// ---- ヒーローのデモ ----

export interface DemoStep {
  status: "オフ" | "待機中" | "聞き取り中" | "認識中" | "入力しました" | "キー操作";
  /** 音声入力がオン (パネルのマイクが青) */
  on?: boolean;
  speak?: boolean;
  /** オフの間も周りの音でメーターが振れる (聞き取らないことを見せる) */
  noise?: boolean;
  preview?: string;
  input: string;
  sent: string[];
  caption: string;
  chip?: string;
  ms: number;
}

const L1 = "ログイン画面のバリデーションを見直してください。";
const L2 = "エラー文言も日本語にそろえてください。";
const M1 = "来週の定例は木曜の 10 時からに変更します。";

/** ヒーローのデモの流れ (デザインの scripts と同じ)。最後まで進むともう一方のモードに替わる */
export const DEMO_SCRIPTS: Record<InputMode, DemoStep[]> = {
  always: [
    {
      status: "待機中",
      on: true,
      input: "",
      sent: [],
      caption: "オンの間は、発話を待ち続けます",
      ms: 1800,
    },
    {
      status: "認識中",
      on: true,
      speak: true,
      preview: "ログイン画面のバリデーションを…",
      input: "",
      sent: [],
      caption: "話している間はプレビューを表示します",
      ms: 1800,
    },
    {
      status: "入力しました",
      on: true,
      input: L1,
      sent: [],
      caption: "話し終えると、カーソル位置に入力します",
      ms: 1600,
    },
    {
      status: "待機中",
      on: true,
      input: L1,
      sent: [],
      caption: "黙っている間は何も入力しません",
      ms: 1500,
    },
    {
      status: "認識中",
      on: true,
      speak: true,
      preview: "エラー文言も日本語にそろえて…",
      input: L1,
      sent: [],
      caption: "続けて話すと、そのまま追記します",
      ms: 1800,
    },
    {
      status: "入力しました",
      on: true,
      input: L1 + L2,
      sent: [],
      caption: "話し終えると、カーソル位置に入力します",
      ms: 1400,
    },
    {
      status: "認識中",
      on: true,
      speak: true,
      preview: "送信",
      input: L1 + L2,
      sent: [],
      caption: "",
      ms: 1000,
    },
    {
      status: "キー操作",
      on: true,
      chip: "「送信」→ ⌘ + Enter",
      input: "",
      sent: [L1 + L2],
      caption: "決まった言葉はキー操作として実行します",
      ms: 2600,
    },
  ],
  once: [
    {
      status: "オフ",
      noise: true,
      input: "",
      sent: [],
      caption: "オフの間は、周りの会話を入力しません",
      ms: 2000,
    },
    {
      status: "オフ",
      chip: SHORTCUT,
      input: "",
      sent: [],
      caption: "ショートカットを押すと、1 回分の聞き取りを始めます",
      ms: 1300,
    },
    {
      status: "聞き取り中",
      on: true,
      input: "",
      sent: [],
      caption: "話し始めるのを待っています",
      ms: 1200,
    },
    {
      status: "認識中",
      on: true,
      speak: true,
      preview: "来週の定例は木曜の 10 時からに…",
      input: "",
      sent: [],
      caption: "話している間はプレビューを表示します",
      ms: 1900,
    },
    {
      status: "入力しました",
      input: M1,
      sent: [],
      caption: "話し終えると入力して、自動でオフに戻ります",
      ms: 1800,
    },
    {
      status: "オフ",
      noise: true,
      input: M1,
      sent: [],
      caption: "次に押すまで、何も入力しません",
      ms: 2000,
    },
  ],
};

/** デモの入力先のアプリ名と、タブの横の補足 */
export const DEMO_MODE_META: Record<InputMode, { appName: string; note: string; label: string }> = {
  always: {
    appName: "AI チャット",
    note: "既定のモード",
    label:
      "mukuchi の動作の例 (常に聞き取る)。AI チャットの入力欄に、話した内容が入力され、「送信」と話すと送信されます。",
  },
  once: {
    appName: "メモ",
    note: `${SHORTCUT} で 1 回分を入力`,
    label: `mukuchi の動作の例 (1回ずつ聞き取る)。オフの間は周りの会話を入力せず、${SHORTCUT} を押してから話した 1 回分だけをメモに入力し、自動でオフに戻ります。`,
  },
};

/**
 * 動きを減らす設定 (prefers-reduced-motion) の時に止めて見せる場面 (どちらも入力まで済んだ状態)。
 * モードのタブは押せるので、モードごとに持つ
 */
export const DEMO_STILL_STEP: Record<InputMode, number> = { always: 5, once: 4 };
