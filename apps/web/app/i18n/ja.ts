import {
  byOs,
  list,
  record,
  type Avail,
  type CtaText,
  type AlwaysRow,
  type DemoPhase,
  type DemoStep,
  type Faq,
  type Feature,
  type IconItem,
  type InputMode,
  type ModeCardText,
  type PerOs,
  type Row,
  type Step,
} from "../lib/content";
import type { CtaTextKey } from "../lib/platform";
import {
  DMG_SIZE_MB,
  MODELS,
  NSIS_SIZE_MB,
  SETUP_MINUTES,
  VERSION,
  formatGb,
  type Os,
} from "../lib/site";

// 日本語の辞書。辞書の型 (Messages) の正。文言はデザイン (mukuchi LP v2 の 1a PC / 1b SP) のまま。
// lp-spec.md で直すと決めた箇所と、Mac / Windows の 2 OS にした箇所 (docs/plans/windows-plan.md §10) だけ変えている。
// OS で変わる文言は PerOs (byOs) に、Windows 版の公開前後で変わる文言は Avail に持つ

const MODEL_NAME = MODELS.macos.ja.name;
const modelSize = (os: Os) => `約 ${formatGb("ja", MODELS[os].ja.bytes)} GB`;
const SETUP_DURATION = `約 ${SETUP_MINUTES} 分`;
const PRICE = "無料";

/** 常駐する場所の呼び方 (desktop の表示に合わせる) */
const TRAY: PerOs<string> = { macos: "メニューバー", windows: "タスクトレイ" };

const L1 = "ログイン画面のバリデーションを見直してください。";
const L2 = "エラー文言も日本語にそろえてください。";
const M1 = "来週の定例は木曜の 10 時からに変更します。";

const ONLY_APPLE_SILICON = "現在は Apple Silicon 搭載の Mac のみに対応しています";

export const ja = {
  meta: {
    title: "mukuchi | 話した言葉だけを、そのまま入力。",
    // meta は事前生成の時点の WINDOWS_AVAILABLE で選ぶ (app/lib/meta.ts)
    description: {
      available:
        "mukuchi は常駐して使う音声入力アプリです（Mac / Windows 対応）。マイクが拾った発話だけを検知して文字に起こし、前面のアプリへそのまま入力します。音声認識はすべて端末内で処理します。",
      soon: "mukuchi は常駐して使う音声入力アプリです（Mac 対応、Windows 版は準備中）。マイクが拾った発話だけを検知して文字に起こし、前面のアプリへそのまま入力します。音声認識はすべて端末内で処理します。",
    } satisfies Avail<string>,
    ogImage: "/og-image.jpg",
    ogImageAlt: "mukuchi — 常駐する音声入力アプリ",
  },

  /** 共有シートに渡す文言 */
  shareText: "常駐する音声入力アプリ mukuchi",

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
    body: "mukuchi は常駐して使う音声入力アプリです。発話だけを検知して文字に起こし、前面のアプリのカーソル位置へ入力します。オンにしておけば、話すたびに入力が進みます。",
    /** キーキャップを文中に挟む (幅の狭い画面で文の途中で自然に折り返すよう) */
    once: { before: "周りに人がいるときは", after: "で 1 回ずつ聞き取れます。" },
    /** スマホ・判定前に出す、ダウンロードできる環境の案内 */
    desktopOnly: {
      available:
        "mukuchi は Mac と Windows の PC 用のアプリです。Mac または Windows の PC のブラウザでこのページを開くと、ダウンロードできます。",
      soon: "mukuchi はパソコン用のアプリです。Mac のブラウザでこのページを開くと、ダウンロードできます（Windows 版は準備中）。",
    } satisfies Avail<string>,
    github: "GitHub で見る",
  },

  /** ダウンロードボタンの下に出す補足 (PC)。any は OS を判定できない時・判定前 */
  downloadMeta: {
    macos: `${VERSION} ・ ${PRICE} ・ Apple Silicon（M1 以降）専用 ・ ${DMG_SIZE_MB} MB`,
    windows: `${VERSION} ・ ${PRICE} ・ Windows 11（64 bit） ・ ${NSIS_SIZE_MB} MB`,
    any: {
      available: `${VERSION} ・ ${PRICE} ・ macOS / Windows`,
      soon: `${VERSION} ・ ${PRICE} ・ macOS（Apple Silicon）`,
    } satisfies Avail<string>,
  },
  /** スマホ版の補足 (幅が狭いのでチップの条件とサイズを省く) */
  downloadMetaShort: {
    available: `${VERSION} ・ ${PRICE} ・ Mac / Windows 用`,
    soon: `${VERSION} ・ ${PRICE} ・ Apple Silicon 専用`,
  } satisfies Avail<string>,

  cta: {
    download: {
      macos: { label: "Mac 版をダウンロード", short: "ダウンロード" },
      windows: { label: "Windows 版をダウンロード", short: "ダウンロード" },
    } satisfies PerOs<{ label: string; short: string }>,
    states: record<CtaTextKey, CtaText>({
      // 判定前 (事前生成の HTML)。押すと動作要件の両 OS のダウンロードへ移る
      pending: {
        label: "ダウンロード",
        short: "ダウンロード",
        note: {
          available: "macOS（Apple Silicon）と Windows 11（x64）に対応しています",
          soon: "macOS（Apple Silicon）に対応しています。Windows 版は準備中です",
        },
      },
      "mac-arm": { note: "Apple Silicon 搭載の Mac を検出しました" },
      "mac-unknown": { note: "Intel 搭載の Mac では動作しません" },
      "mac-intel": {
        label: "Apple Silicon 専用です",
        short: "非対応",
        note: "Intel 搭載の Mac には対応していません",
      },
      // 署名なしのため SmartScreen の警告が出る (docs/release.md「署名なし (SmartScreen)」)。
      // Safari・Firefox では x64 と ARM を区別できないので x64 用と書く
      "windows-x64": {
        note: "Windows 11（x64）用です。署名前のため、初回に警告が出たら「詳細情報」→「実行」を選びます",
      },
      "windows-arm": {
        label: "ARM 版の Windows には非対応",
        short: "非対応",
        note: "Windows 11 の x64 版（Intel・AMD の CPU）に対応しています",
      },
      "windows-soon": { label: "Windows 版は準備中", short: "準備中", note: ONLY_APPLE_SILICON },
      linux: {
        label: { available: "Mac / Windows 版のみ", soon: "Mac 版のみ" },
        short: { available: "Mac / Windows 版のみ", soon: "Mac 版のみ" },
        note: {
          available: "Mac または Windows の PC でダウンロードしてください",
          soon: ONLY_APPLE_SILICON,
        },
      },
      mobile: {
        label: { available: "PC でダウンロード", soon: "Mac でダウンロード" },
        short: { available: "PC 版のみ", soon: "Mac 版のみ" },
        note: {
          available: "Mac または Windows の PC のブラウザでこのページを開いてください",
          soon: "Mac のブラウザでこのページを開いてください",
        },
      },
      other: {
        label: "デスクトップ版のみ提供",
        short: { available: "Mac / Windows 版のみ", soon: "Mac 版のみ" },
        note: {
          available: "Mac または Windows の PC からアクセスしてください",
          soon: "Apple Silicon 搭載の Mac からアクセスしてください",
        },
      },
    }),
    /** ボタンの下の、ほかの OS 版へのリンク (別の PC で使う人向け) */
    alt: {
      label: "別の PC で使う場合",
      links: { macos: "Mac 版（dmg）", windows: "Windows 版（exe）" } satisfies PerOs<string>,
    },
    copyUrl: "URL をコピー",
    copied: "コピーしました",
    share: "共有",
    platforms: {
      macos: "macOS（Apple Silicon）",
      windows: "Windows 11（x64）",
      available: "提供中",
      comingSoon: "準備中",
      /** Linux (予定のみ) */
      planned: "準備中",
    },
  },

  modes: {
    title: { lead: "聞き取り方は、", rest: "2 つから選べます" },
    // デザインの lead は「モードは初回セットアップで選びます。」だが、設定 > 音声入力 でも変えられるためそれも書く
    lead: "既定は「常に聞き取る」です。周りに人がいるときや、入力するタイミングを自分で決めたいときは「1回ずつ聞き取る」を使います。モードは初回セットアップで選び、あとから設定で変更できます。",
    /** モード名。アプリの表示と同じ (「1回ずつ」は詰めて書く) */
    names: { always: "常に聞き取る", once: "1回ずつ聞き取る" } satisfies Record<InputMode, string>,
    defaultBadge: "既定",
    whenLabel: "こんなときに",
    cards: byOs((k) =>
      record<InputMode, ModeCardText>({
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
            {
              f: 15,
              t: `${k.shortcut} → 1 回分を入力`,
              tSp: `${k.shortcut} → 1 回分`,
              active: true,
            },
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
    ),
    shortcut: byOs((k, os) => ({
      title: `どのアプリを使っていても、${k.shortcut} で操作できます`,
      body: `押して離すだけで、押し続ける必要はありません。キーは設定で変更・無効化できます。パネルのボタンと${TRAY[os]}からも同じ操作ができます。`,
    })),
  },

  features: {
    title: "入力を、声で済ませる",
    items: list<Feature>([
      {
        no: "01",
        visual: "always",
        title: "ローカルで動くから、常に起動しておける",
        body: "音声認識はすべてお使いの端末の中で処理します。クラウドの利用料や回数の上限がないため、朝から晩までオンのままにしておけます。",
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
    commands: byOs((k) => [
      { word: "確定", key: "Enter" },
      { word: "エンター", key: "Enter" },
      { word: "改行", key: k.newline },
      { word: "送信", key: k.send },
    ]),
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
    title: "音声は端末の外に出ません",
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
    /** 手順を出し分ける OS のタブ */
    osTabsLabel: "手順を表示する OS",
    steps: byOs((k, os) =>
      list<Step>([
        os === "macos"
          ? {
              no: "1",
              title: "ダウンロードしてインストール",
              body: `dmg（約 ${DMG_SIZE_MB} MB）を開き、mukuchi をアプリケーションフォルダに移動します。`,
            }
          : {
              no: "1",
              title: "ダウンロードしてインストール",
              // NSIS の currentUser (管理者権限不要)。署名なしのため SmartScreen の警告が出る
              body: `インストーラー（exe、約 ${NSIS_SIZE_MB} MB）を実行します。警告が出たら「詳細情報」→「実行」を選びます。管理者権限は要りません。`,
            },
        os === "macos"
          ? {
              no: "2",
              title: "権限を許可",
              body: "マイクとアクセシビリティの使用を許可します。アクセシビリティはほかのアプリへ入力するために使います。",
            }
          : {
              no: "2",
              title: "マイクを許可",
              body: "マイクの使用を許可します。オフになっている場合は、アプリの案内から Windows の設定を開けます。",
            },
        {
          no: "3",
          title: "音声認識モデルを取得",
          body:
            os === "macos"
              ? `${MODEL_NAME}（${modelSize(os)}）をダウンロードします。`
              : `${MODEL_NAME}（${modelSize(os)}）をダウンロードします。GPU が見つからない場合は、CPU で動かすかを確認します。`,
        },
        {
          no: "4",
          title: "入力モードとショートカットを選ぶ",
          body: `「常に聞き取る」か「1回ずつ聞き取る」を選び、ショートカット（既定は ${k.shortcut}）を確認します。`,
        },
        { no: "5", title: "試しに話す", body: "実際に話して、入力されることを確認します。" },
      ]),
    ),
  },

  requirements: {
    title: "動作要件",
    lead: {
      available: "Apple Silicon 搭載の Mac と、Windows 11（x64）の PC で動作します。",
      soon: "Apple Silicon 搭載の Mac で動作します。Windows 版は準備中です。",
    } satisfies Avail<string>,
    osNames: { macos: "macOS", windows: "Windows" } satisfies PerOs<string>,
    comingSoon: "準備中",
    download: {
      macos: `ダウンロード（dmg・${DMG_SIZE_MB} MB）`,
      windows: `ダウンロード（exe・${NSIS_SIZE_MB} MB）`,
    } satisfies PerOs<string>,
    // 「動作確認」は実機で確かめた構成だけ、「目安」「未確認」はそう書く (windows-plan.md §12 の未検証)
    rows: {
      macos: list<Row>([
        { k: "OS", v: "macOS 13 Ventura 以降" },
        { k: "チップ", v: "Apple Silicon（M1 以降）" },
        { k: "動作確認", v: "M1 Max・M3 Pro" },
        { k: "メモリ", v: "16 GB 以上を推奨" },
        { k: "ストレージ", v: "空き容量 6 GB 以上" },
        { k: "標準モデル", v: `${MODEL_NAME}（日本語・${modelSize("macos")}）` },
        { k: "バージョン", v: VERSION },
        { k: "価格", v: PRICE },
      ]),
      windows: list<Row>([
        { k: "OS", v: "Windows 11（64 bit・x64）。ARM 版は非対応" },
        // VRAM は RTX 3080 Ti で Vulkan 版の llama-server を動かした実測 (WINDOWS_DECISION.md)
        { k: "GPU", v: "推奨。Vulkan に対応した GPU（認識中の VRAM 使用量は約 3 GB）" },
        { k: "CPU のみ", v: "非推奨。同意の上で使えますが、認識に 1〜3 秒以上かかる目安です" },
        { k: "動作確認", v: "GeForce RTX 3080 Ti・Core i9-12900KF の PC のみ" },
        { k: "未確認", v: "AMD・Intel の GPU、内蔵 GPU のみの PC、性能の低い CPU" },
        { k: "メモリ", v: "未確認（動作確認した PC は 64 GB）" },
        { k: "ストレージ", v: "空き容量 6 GB 以上（目安）" },
        { k: "標準モデル", v: `${MODEL_NAME}（日本語・${modelSize("windows")}）` },
        {
          k: "署名",
          v: "なし。初回に SmartScreen の警告が出ます。Smart App Control が有効な PC では使えません",
        },
        { k: "バージョン", v: VERSION },
        { k: "価格", v: PRICE },
      ]),
    } satisfies PerOs<Row[]>,
  },

  faq: {
    title: "よくある質問",
    items: list<Faq>([
      {
        q: "Windows で「PC が保護されました」と表示されます",
        a: [
          "mukuchi の Windows 版はコード署名をしていないため、ダウンロードしたインストーラーを実行すると Microsoft Defender SmartScreen の警告が出ます。「詳細情報」を押し、「実行」を選ぶと進めます。",
          "Smart App Control（スマート アプリ コントロール）が有効な PC では、署名のないアプリを実行できないため mukuchi を使えません。回避する方法はありません。",
        ],
      },
      {
        q: "GPU のない Windows の PC でも使えますか",
        a: [
          "GPU のある PC をおすすめします。初回セットアップで GPU を確認し、見つからない場合は、同意の上で CPU だけで動かせます。CPU のみでは認識に 1〜3 秒以上かかる目安で、使い心地が大きく下がります。",
          "動作を確認したのは GeForce RTX 3080 Ti・Core i9-12900KF の PC のみです。AMD・Intel の GPU や内蔵 GPU のみの PC での速度は確認していません。",
        ],
      },
    ]),
  },

  finalCta: {
    title: { lead: "まずは常駐させて、", rest: "一日使ってみてください" },
    lead: `無料で使えます。インストールから入力開始まで${SETUP_DURATION}です。`,
    leadMobile: {
      available:
        "無料で使えます。Mac または Windows の PC のブラウザでこのページを開き、ダウンロードしてください。",
      soon: "無料で使えます。Mac のブラウザでこのページを開き、ダウンロードしてください（Windows 版は準備中）。",
    } satisfies Avail<string>,
  },

  footer: {
    company: "株式会社 Minimal",
    supportedOs: {
      available: "対応 OS: macOS（Apple Silicon）・Windows 11（x64）",
      soon: "対応 OS: macOS（Apple Silicon）。Windows 版は準備中",
    } satisfies Avail<string>,
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
    modeMeta: byOs((k) => ({
      always: {
        appName: "AI チャット",
        note: "既定のモード",
        label:
          "mukuchi の動作の例 (常に聞き取る)。AI チャットの入力欄に、話した内容が入力され、「送信」と話すと送信されます。",
      },
      once: {
        appName: "メモ",
        note: `${k.shortcut} で 1 回分を入力`,
        label: `mukuchi の動作の例 (1回ずつ聞き取る)。オフの間は周りの会話を入力せず、${k.shortcut} を押してから話した 1 回分だけをメモに入力し、自動でオフに戻ります。`,
      },
    })) satisfies PerOs<Record<InputMode, { appName: string; note: string; label: string }>>,
    /** ヒーローのデモの流れ (デザインの scripts と同じ)。最後まで進むともう一方のモードに替わる */
    scripts: byOs((k) => ({
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
          chip: `「送信」→ ${k.send}`,
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
          chip: k.shortcut,
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
    })) satisfies PerOs<Record<InputMode, DemoStep[]>>,
  },
};

/** 辞書の型。ほかの言語は `satisfies Messages` でキーの欠落・余分を型検査で落とす */
export type Messages = typeof ja;
