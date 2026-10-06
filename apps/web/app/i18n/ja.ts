import {
  list,
  record,
  type CtaText,
  type AlwaysRow,
  type DemoPhase,
  type DemoStep,
  type Feature,
  type IconItem,
  type InputMode,
  type ModeCardText,
  type Step,
} from "../lib/content";
import type { Platform } from "../lib/platform";
import { DMG_SIZE_MB, MODELS, SETUP_MINUTES, SHORTCUT, VERSION, formatGb } from "../lib/site";

// 日本語の辞書。辞書の型 (Messages) の正。文言はデザイン (mukuchi LP v2 の 1a PC / 1b SP) のまま。
// lp-spec.md で直すと決めた箇所だけ変えている

const MODEL = MODELS.ja;
const MODEL_SIZE = `約 ${formatGb("ja", MODEL.bytes)} GB`;
const DMG_SIZE = `${DMG_SIZE_MB} MB`;
const SETUP_DURATION = `約 ${SETUP_MINUTES} 分`;
const PRICE = "無料";

const L1 = "ログイン画面のバリデーションを見直してください。";
const L2 = "エラー文言も日本語にそろえてください。";
const M1 = "来週の定例は木曜の 10 時からに変更します。";

const ONLY_APPLE_SILICON = "現在は Apple Silicon 搭載の Mac のみに対応しています";

export const ja = {
  meta: {
    title: "mukuchi | 話した言葉だけを、そのまま入力。",
    description:
      "mukuchi は Mac に常駐する音声入力アプリです。マイクが拾った発話だけを検知して文字に起こし、前面のアプリへそのまま入力します。音声認識はすべて端末内で処理します。",
    ogImage: "/og-image.jpg",
    ogImageAlt: "mukuchi — Mac に常駐する音声入力アプリ",
  },

  /** 共有シートに渡す文言 */
  shareText: "Mac 用の音声入力アプリ mukuchi",

  nav: {
    label: "ページ内",
    modes: "入力モード",
    features: "特長",
    privacy: "プライバシー",
    setup: "セットアップ",
    language: "言語",
  },

  hero: {
    title: ["話した言葉だけを、", "そのまま入力。"],
    body: "mukuchi は Mac に常駐する音声入力アプリです。発話だけを検知して文字に起こし、前面のアプリのカーソル位置へ入力します。オンにしておけば、話すたびに入力が進みます。",
    /** キーキャップを文中に挟む (幅の狭い画面で文の途中で自然に折り返すよう) */
    once: { before: "周りに人がいるときは", after: "で 1 回ずつ聞き取れます。" },
    macOnly:
      "mukuchi は Mac 用のアプリです。Mac のブラウザでこのページを開くと、ダウンロードできます。",
    github: "GitHub で見る",
  },

  /** ダウンロードボタンの下に出す補足 (PC) */
  downloadMeta: `${VERSION} ・ ${PRICE} ・ Apple Silicon（M1 以降）専用 ・ ${DMG_SIZE}`,
  /** スマホ版の補足 (幅が狭いのでチップの条件とサイズを省く) */
  downloadMetaShort: `${VERSION} ・ ${PRICE} ・ Apple Silicon 専用`,

  cta: {
    download: { label: "Mac 版をダウンロード", short: "ダウンロード" },
    states: record<Platform, CtaText>({
      "mac-arm": { note: "Apple Silicon 搭載の Mac を検出しました" },
      "mac-unknown": { note: "Intel 搭載の Mac では動作しません" },
      "mac-intel": {
        label: "Apple Silicon 専用です",
        short: "非対応",
        note: "Intel 搭載の Mac には対応していません",
      },
      windows: { label: "Windows 版は準備中", short: "準備中", note: ONLY_APPLE_SILICON },
      linux: { label: "Linux 版は準備中", short: "準備中", note: ONLY_APPLE_SILICON },
      mobile: {
        label: "Mac でダウンロード",
        short: "Mac 版のみ",
        note: "Mac のブラウザでこのページを開いてください",
      },
      other: {
        label: "デスクトップ版のみ提供",
        short: "Mac 版のみ",
        note: "Apple Silicon 搭載の Mac からアクセスしてください",
      },
    }),
    copyUrl: "URL をコピー",
    copied: "コピーしました",
    share: "共有",
    platforms: { mac: "macOS（Apple Silicon）", available: "提供中", comingSoon: "準備中" },
  },

  modes: {
    title: { lead: "聞き取り方は、", rest: "2 つから選べます" },
    // デザインの lead は「モードは初回セットアップで選びます。」だが、設定 > 音声入力 でも変えられるためそれも書く
    lead: "既定は「常に聞き取る」です。周りに人がいるときや、入力するタイミングを自分で決めたいときは「1回ずつ聞き取る」を使います。モードは初回セットアップで選び、あとから設定で変更できます。",
    /** モード名。アプリの表示と同じ (「1回ずつ」は詰めて書く) */
    names: { always: "常に聞き取る", once: "1回ずつ聞き取る" } satisfies Record<InputMode, string>,
    defaultBadge: "既定",
    whenLabel: "こんなときに",
    cards: record<InputMode, ModeCardText>({
      always: {
        body: "オンの間、話すたびに文字に起こして入力します。黙っている間は何も入力しません。",
        segs: [
          { f: 1, t: "オンの間、発話ごとに入力", tSp: "オンの間、発話ごとに入力", active: true },
        ],
        when: ["ひとりで作業しているとき", "話すだけで次々に入力したいとき"],
        keys: [{ when: "を押す", does: "オン / オフを切り替えます" }],
      },
      once: {
        body: "ショートカットを押してから話し終わるまでを 1 回だけ文字にして入力し、自動でオフに戻ります。",
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
    }),
    shortcut: {
      title: `どのアプリを使っていても、${SHORTCUT} で操作できます`,
      body: "押して離すだけで、押し続ける必要はありません。キーは設定で変更・無効化できます。パネルのボタンとメニューバーからも同じ操作ができます。",
    },
  },

  features: {
    title: "入力を、声で済ませる",
    items: list<Feature>([
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
    ]),
    alwaysRows: list<AlwaysRow>([
      { icon: "wifi-off", k: "文字起こし時の通信", v: "0 件" },
      { icon: "infinity", k: "1 日あたりの利用上限", v: "なし" },
      // 「入力開始に必要な操作: なし」は 1回ずつ聞き取る (ショートカットで始める) と矛盾するため置き換えた
      { icon: "user-round", k: "アカウント登録", v: "不要" },
    ]),
    vadLegend: { speech: "発話（文字起こしして入力）", silence: "無音・環境音（何もしない）" },
    /** アプリの既定の音声コマンド (docs/architecture.md「言語」の ja)。「確定」と「エンター」は同じ Enter */
    commands: [
      { word: "確定", key: "Enter" },
      { word: "エンター", key: "Enter" },
      { word: "改行", key: "⇧ + Enter" },
      { word: "送信", key: "⌘ + Enter" },
    ],
    /** 音声コマンドの言葉を囲む (日本語は鉤括弧) */
    quote: (w: string) => `「${w}」`,
    extrasTitle: "作業の邪魔をしないための機能",
    extras: list<IconItem>([
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
        title: "認識のヒント",
        body: "用語の書き方や話題を文章で伝えられます。「Qwen（クウェン）は英字で書く」のように指示すると、その表記で認識されやすくなります。",
      },
    ]),
  },

  privacy: {
    title: "音声は Mac の外に出ません",
    lead: "文字起こしはすべて端末内で処理します。社外秘の資料や顧客情報を扱う業務でも使えます。",
    items: list<IconItem>([
      { icon: "cpu", title: "端末内で文字起こし", body: "音声を外部のサーバーに送信しません。" },
      { icon: "trash-2", title: "録音を残さない", body: "音声を保存しません。" },
      // アップデートの確認・取得も通信なので書く。自動確認は設定で止められる (lp-spec)
      {
        icon: "wifi-off",
        title: "通信はモデルとアップデートの取得のみ",
        body: "音声認識モデルのダウンロードと、アップデートの確認・ダウンロード以外に通信しません。アップデートの自動確認は設定で止められます。",
      },
      {
        icon: "code-xml",
        title: "ソースコードを公開",
        body: "処理の内容は GitHub で確認できます。",
      },
    ]),
  },

  setup: {
    title: "セットアップ",
    lead: `アカウント登録は不要です。モデルのダウンロードを含めて${SETUP_DURATION}で完了します。`,
    steps: list<Step>([
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
        body: `${MODEL.name}（${MODEL_SIZE}）をダウンロードします。`,
      },
      {
        no: "4",
        title: "入力モードとショートカットを選ぶ",
        body: `「常に聞き取る」か「1回ずつ聞き取る」を選び、ショートカット（既定は ${SHORTCUT}）を確認します。`,
      },
      { no: "5", title: "試しに話す", body: "実際に話して、入力されることを確認します。" },
    ]),
  },

  requirements: {
    title: "動作要件",
    lead: "Apple Silicon 搭載の Mac で動作します。",
    rows: [
      { k: "OS", v: "macOS 13 Ventura 以降" },
      { k: "チップ", v: "Apple Silicon（M1 以降）" },
      { k: "動作確認", v: "M1 Max・M3 Pro" },
      { k: "メモリ", v: "16 GB 以上を推奨" },
      { k: "ストレージ", v: "空き容量 6 GB 以上" },
      { k: "標準モデル", v: `${MODEL.name}（日本語・${MODEL_SIZE}）` },
      { k: "バージョン", v: VERSION },
      { k: "価格", v: PRICE },
    ],
  },

  finalCta: {
    title: { lead: "まずは常駐させて、", rest: "一日使ってみてください" },
    lead: `無料で使えます。インストールから入力開始まで${SETUP_DURATION}です。`,
    leadMobile: "無料で使えます。Mac のブラウザでこのページを開き、ダウンロードしてください。",
  },

  footer: {
    company: "株式会社 Minimal",
    analytics: "本サイトは Google Analytics を利用して閲覧状況を計測しています。",
    analyticsLink: "Google によるデータの使用について",
  },

  demo: {
    tabsLabel: "デモの聞き取り方",
    status: {
      off: "オフ",
      waiting: "待機中",
      listening: "聞き取り中",
      recognizing: "認識中",
      inserted: "入力しました",
      key: "キー操作",
    } satisfies Record<DemoPhase, string>,
    /** デモの入力先のアプリ名と、タブの横の補足 */
    modeMeta: {
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
    } satisfies Record<InputMode, { appName: string; note: string; label: string }>,
    /** ヒーローのデモの流れ (デザインの scripts と同じ)。最後まで進むともう一方のモードに替わる */
    scripts: {
      always: list<DemoStep>([
        {
          phase: "waiting",
          on: true,
          input: "",
          sent: [],
          caption: "オンの間は、発話を待ち続けます",
          ms: 1800,
        },
        {
          phase: "recognizing",
          on: true,
          speak: true,
          preview: "ログイン画面のバリデーションを…",
          input: "",
          sent: [],
          caption: "話している間はプレビューを表示します",
          ms: 1800,
        },
        {
          phase: "inserted",
          on: true,
          input: L1,
          sent: [],
          caption: "話し終えると、カーソル位置に入力します",
          ms: 1600,
        },
        {
          phase: "waiting",
          on: true,
          input: L1,
          sent: [],
          caption: "黙っている間は何も入力しません",
          ms: 1500,
        },
        {
          phase: "recognizing",
          on: true,
          speak: true,
          preview: "エラー文言も日本語にそろえて…",
          input: L1,
          sent: [],
          caption: "続けて話すと、そのまま追記します",
          ms: 1800,
        },
        {
          phase: "inserted",
          on: true,
          input: L1 + L2,
          sent: [],
          caption: "話し終えると、カーソル位置に入力します",
          ms: 1400,
        },
        {
          phase: "recognizing",
          on: true,
          speak: true,
          preview: "送信",
          input: L1 + L2,
          sent: [],
          caption: "",
          ms: 1000,
        },
        {
          phase: "key",
          on: true,
          chip: "「送信」→ ⌘ + Enter",
          input: "",
          sent: [L1 + L2],
          caption: "決まった言葉はキー操作として実行します",
          ms: 2600,
        },
      ]),
      once: list<DemoStep>([
        {
          phase: "off",
          noise: true,
          input: "",
          sent: [],
          caption: "オフの間は、周りの会話を入力しません",
          ms: 2000,
        },
        {
          phase: "off",
          chip: SHORTCUT,
          input: "",
          sent: [],
          caption: "ショートカットを押すと、1 回分の聞き取りを始めます",
          ms: 1300,
        },
        {
          phase: "listening",
          on: true,
          input: "",
          sent: [],
          caption: "話し始めるのを待っています",
          ms: 1200,
        },
        {
          phase: "recognizing",
          on: true,
          speak: true,
          preview: "来週の定例は木曜の 10 時からに…",
          input: "",
          sent: [],
          caption: "話している間はプレビューを表示します",
          ms: 1900,
        },
        {
          phase: "inserted",
          input: M1,
          sent: [],
          caption: "話し終えると入力して、自動でオフに戻ります",
          ms: 1800,
        },
        {
          phase: "off",
          noise: true,
          input: M1,
          sent: [],
          caption: "次に押すまで、何も入力しません",
          ms: 2000,
        },
      ]),
    } satisfies Record<InputMode, DemoStep[]>,
  },
};

/** 辞書の型。ほかの言語は `satisfies Messages` でキーの欠落・余分を型検査で落とす */
export type Messages = typeof ja;
