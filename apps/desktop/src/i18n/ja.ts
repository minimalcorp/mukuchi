/*
 * 日本語の辞書。これを正とし、型 Messages はここから作る (他の言語は `satisfies Messages` でキーの欠落を型検査で落とす)。
 * 数値・サイズ・時刻は Intl で整形した文字列を受け取る (ここに単位や桁区切りを直書きしない)。
 * 文中に要素を差し込む文言は rich() で組み立てる (語順は言語ごとに違うため)。
 * Rust から届く文言 (AppError.message・各 error・reject の文言・モデルの名前と説明) はここに置かない (Rust が表示言語で作る)
 *
 * OS で変わる文言・キー表記だけを { macos, windows } (PerOs) にし、使う側は useI18n() の os() で取る (例 os(t.common.openSystemSettings))。
 * OS で変わらない文言は 1 つのまま書く。Windows でしか出ない文言 (gpu) も 1 つのまま書く
 */
import type { ReactNode } from "react";
import type { Locale } from "@/lib/ipc";
import type { PerOs } from "@/lib/platform";
import { rich } from "./rich";

export const ja = {
  /** 表示言語で書いた言語名 (文中で使う。選択肢は各言語の自称 LOCALE_AUTONYMS) */
  languageName: { ja: "日本語", en: "英語" } satisfies Record<Locale, string>,

  common: {
    openSystemSettings: { macos: "システム設定を開く", windows: "Windows の設定を開く" } satisfies PerOs<string>,
    cancel: "キャンセル",
    close: "閉じる",
    delete: "削除",
    save: "保存",
    next: "次へ",
    back: "戻る",
    skip: "スキップ",
    allow: "許可する",
    granted: "許可済み",
    notGranted: "未許可",
    checking: "確認しています…",
    help: "説明",
    restart: "再起動",
    openSetup: "セットアップを開く",
    pause: "一時停止",
    resume: "再開",
    retry: "再試行",
    download: "ダウンロード",
    /** 状態の文言を並べる区切り (「0.9 GB / 2.4 GB ・ 残り約 3 分」) */
    separator: " ・ ",
  },

  format: {
    etaUnderMinute: "残り 1 分未満",
    etaMinutes: (n: number) => `残り約 ${n} 分`,
    today: (time: string) => `今日 ${time}`,
    dateTime: (date: string, time: string) => `${date} ${time}`,
    seconds: (value: string) => `${value} 秒`,
  },

  /** 復旧操作のボタン (AppError.action)。OS で変わるものだけ PerOs */
  errorActions: {
    open_accessibility: "システム設定を開く",
    open_microphone: { macos: "システム設定を開く", windows: "Windows の設定を開く" } satisfies PerOs<string>,
    select_microphone: "マイクを選択",
    restart_asr: "再起動",
    start_setup: "セットアップを開く",
    accept_cpu: "CPU で続ける",
    probe_gpu: "再検出",
  },

  inputMode: {
    groupLabel: "入力モード",
    continuous: {
      label: "常に聞き取る",
      description: "オンの間、話すたびに文字にします",
      useCases: ["ひとりで作業しているとき", "話すだけで次々に入力したいとき"],
    },
    oneShot: {
      label: "1回ずつ聞き取る",
      description: "ショートカットを押してから話し終わるまでを1回だけ文字にします",
      useCases: ["周りに人がいる・会話が聞こえる場所", "入力するタイミングを自分で決めたいとき"],
    },
    shortcutHint: {
      continuous: "押すたびに音声入力をオン／オフします",
      oneShot: "押すと1回聞き取ります。話し終わると自動でオフになります",
    },
  },

  shortcut: {
    label: "ショートカット",
    help: "どのアプリを使っていても押せます。他のアプリと同じキーだと動かないことがあります",
    recordingGuide: {
      macos: "⌃ ⌥ ⇧ ⌘ のいずれかと一緒に押してください。esc で取り消し、⌫ でなしにします",
      windows: "Ctrl・Alt・Shift・Win のいずれかと一緒に押してください。Esc で取り消し、Backspace でなしにします",
    } satisfies PerOs<string>,
    unsupportedGuide: "このキーはショートカットに使えません。別のキーを押してください。esc で取り消します",
    pressKeys: "キーを押してください",
    none: "なし",
    change: "変更",
    clear: "ショートカットをなしにする",
  },

  panel: {
    turnOn: "音声入力をオン",
    turnOff: "音声入力をオフ",
    loadingModel: "モデルを読み込んでいます…",
    loadingModelShort: "モデルを読み込んでいます",
    errors: {
      accessibility_denied: "アクセシビリティが未許可です",
      microphone_denied: "マイクが未許可です",
      asr_stopped: "文字起こしが停止しました",
      microphone_missing: "マイクが見つかりません",
      runtime_missing: "モデルがありません",
      insert_failed: "入力できませんでした",
      vad_failed: "発話検出を開始できません",
      gpu_unavailable: "GPU を使えません",
    },
    idle: "待機中",
    speaking: "認識中",
    finalizing: "確定しています…",
    inserted: "入力しました",
    command: "音声コマンド",
    excluded: (app: string) => `${app} は入力しない設定です`,
    commandSent: (key: ReactNode): ReactNode => rich(key, " を送信しました"),
  },

  /**
   * GPU の判定と CPU 実行の同意 (Windows のみ。docs/architecture.md「GPU の判定と CPU 実行の同意」)。
   * セットアップの差し込み画面・設定の「認識」・gpu_unavailable の復旧で共通
   */
  gpu: {
    heading: "文字起こしに使うデバイス",
    help: "文字起こしは GPU で行います。GPU を使えない PC では、同意すると CPU で動かせます（認識に時間がかかります）",
    detect: "再検出",
    checking: "GPU を確認しています…",
    continueCpu: "CPU で続ける",
    continueCpuEllipsis: "CPU で続ける…",
    noneTitle: "GPU が見つかりません",
    driverTitle: "GPU を使えません",
    noneLead: "この PC に、文字起こしに使える GPU が見つかりません。",
    driverLead: "GPU は見つかりましたが、文字起こしに使えません。GPU のドライバーが古いか、正しく入っていない可能性があります。",
    cpuWarning:
      "CPU でも動きますが、認識に 1〜3 秒以上かかり、使い心地が大きく下がります。GPU のある PC での利用をおすすめします。",
    driverHint: "GPU のメーカー（NVIDIA・AMD・Intel）のサイトから最新のドライバーを入れて、再検出してください。",
    noneHint: "GPU があるのに見つからない場合は、GPU のドライバーを更新してから再検出してください。",
    consentTitle: "CPU で続けますか？",
    cancel: "やめる",
    gpu: "GPU",
    integrated: "内蔵 GPU",
    cpu: "CPU",
    okSub: "GPU で文字起こしします",
    integratedSub: "内蔵 GPU で文字起こしします。認識に時間がかかることがあります",
    cpuSub: "GPU を使えないため、CPU で文字起こしします。認識に時間がかかります",
  },

  setup: {
    windowTitle: "mukuchi セットアップ",
    progress: (step: number, total: number) => `${step} / ${total}`,
    welcome: {
      title: "mukuchi へようこそ",
      lead: "話すだけで文字を入力できる音声入力アプリです。いくつかの準備を済ませると使えるようになります。",
      privacy: {
        macos: "文字起こしはこの Mac の中で行い、音声は外部に送信しません",
        windows: "文字起こしはこの PC の中で行い、音声は外部に送信しません",
      } satisfies PerOs<string>,
      download: "実行環境とモデルをダウンロードします",
      downloadWithSize: (size: string) => `実行環境とモデル（約 ${size}）をダウンロードします`,
      duration: "所要時間の目安は 5〜10 分です",
      uiLanguage: "表示言語",
      speechLanguage: "話す言語",
      speechLanguageHelp: "文字起こしする言語です。ダウンロードするモデルもこの言語に合わせて選びます。あとから設定の「認識」で変えられます",
      speechLanguageLocked: "ダウンロードを始めたため、セットアップの後に設定の「認識」で変えてください",
      speechLanguageLockedRunning: "準備の実行中は変えられません。セットアップの後に設定の「認識」で変えてください",
      start: "はじめる",
    },
    permissions: {
      title: "権限を許可してください",
      // Windows はマイクのみ (アクセシビリティの権限がない)
      lead: { macos: "2 つとも許可すると次に進めます。", windows: "マイクを許可すると次に進めます。" } satisfies PerOs<string>,
      microphone: "マイク",
      microphoneSub: "発話を聞き取るために使います",
      accessibility: "アクセシビリティ",
      accessibilityHelp: "他のアプリのカーソル位置に文字とキー操作を送るために必要です",
      accessibilitySub: "文字の入力に使います",
      guideMicNotDetermined: {
        macos: "マイクの使用を許可してください。確認のダイアログが表示されます。",
        windows: "マイクの使用を許可してください。",
      } satisfies PerOs<string>,
      guideMicDenied: {
        macos: "システム設定のマイクで mukuchi をオンにしてください。許可するとここに自動で反映されます。",
        windows:
          "Windows の設定のマイクで「マイクへのアクセス」と「デスクトップ アプリがマイクにアクセスできるようにする」をオンにしてください。許可するとここに自動で反映されます。",
      } satisfies PerOs<string>,
      guideAccessibility: "システム設定で mukuchi をオンにしてください。許可するとここに自動で反映されます。",
    },
    download: {
      titlePending: "実行環境とモデルのダウンロード",
      checkingStatus: "状態を確認しています…",
      titleDone: "実行環境とモデルの準備ができました",
      titlePaused: "ダウンロードを一時停止しました",
      titleFailed: "準備を完了できませんでした",
      titleRunning: "実行環境とモデルをダウンロードしています",
      overall: "全体",
      overallProgress: "全体の進捗",
      // Windows は同梱の llama.cpp (llama-server) を配置する
      runtime: { macos: "Python 実行環境", windows: "実行環境 (llama.cpp)" } satisfies PerOs<string>,
      /** モデルの一覧を取得する前の名前 (取得後は ModelInfo.name) */
      modelFallback: "音声認識モデル",
      verify: "動作確認",
      runningRuntime: "準備しています…",
      // model の大きさはファイル一覧を取得するまで分からない
      runningModel: "ファイル一覧を取得しています…",
      runningVerify: "確認しています…",
      preparingRuntime: "実行環境を準備しています",
      etaCalculating: "残り時間を計算しています",
      verifying: "動作を確認しています",
      paused: "一時停止中",
      pending: "待機中",
      done: "完了",
      failed: "失敗",
      failedFallback: "準備に失敗しました。",
      resumeFrom: (size: string) => `取得済みの ${size} から再開します。`,
    },
    inputMode: {
      title: "入力のしかたを選んでください",
      useCases: "こんなときに",
    },
    test: {
      title: "試しに話してみてください",
      // sample は話す言語の例文 (SAMPLE_PHRASES)
      oneShotWithKeys: (keys: ReactNode, sample: string): ReactNode =>
        rich("画面の下にパネルを表示しました。", keys, ` を押して、「${sample}」のように話してください。話し終わると自動でオフになります。`),
      oneShotNoKeys: (sample: string) =>
        `画面の下にパネルを表示しました。パネルで音声入力をオンにして、「${sample}」のように話してください。話し終わると自動でオフになります。`,
      continuousWithKeys: (keys: ReactNode, sample: string): ReactNode =>
        rich("画面の下にパネルを表示しました。パネルか ", keys, ` で音声入力をオンにして、「${sample}」のように話してください。`),
      continuousNoKeys: (sample: string) =>
        `画面の下にパネルを表示しました。パネルで音声入力をオンにして、「${sample}」のように話してください。`,
      inputLevel: "入力レベル",
      field: "テスト入力欄",
      sentKey: (key: string) => `${key} を送信`,
      recognized: "正しく認識できました。",
    },
    done: {
      title: "準備ができました",
      lead: {
        macos: "mukuchi はメニューバーに常駐します。設定はメニューバーのアイコンから開けます。",
        windows: "mukuchi はタスクトレイに常駐します。設定はタスクトレイのアイコンから開けます。",
      } satisfies PerOs<string>,
      hintOneShot: {
        macos: (keys: ReactNode): ReactNode =>
          rich(keys, " を押すと1回聞き取ります。パネルやメニューバーのアイコンからも始められます"),
        windows: (keys: ReactNode): ReactNode =>
          rich(keys, " を押すと1回聞き取ります。パネルやタスクトレイのアイコンからも始められます"),
      },
      hintWithKeys: {
        macos: (keys: ReactNode): ReactNode => rich("オン／オフはパネル・メニューバーのアイコン・", keys, "で切り替えます"),
        windows: (keys: ReactNode): ReactNode => rich("オン／オフはパネル・タスクトレイのアイコン・", keys, "で切り替えます"),
      },
      hintNoKeys: {
        macos: "オン／オフはパネルか、メニューバーのアイコンから切り替えます",
        windows: "オン／オフはパネルか、タスクトレイのアイコンから切り替えます",
      } satisfies PerOs<string>,
      launchAtLogin: "ログイン時に起動",
      // Windows のみ (OsFeatures.shortcutConflictNotice)。Mac は他アプリとの衝突を検出できないため出さない
      shortcutConflict: (keys: ReactNode): ReactNode =>
        rich("ショートカット ", keys, " は他のアプリが使っているため登録できません。別のキーを選んでください"),
    },
  },

  settings: {
    categories: {
      general: "一般",
      voice: "音声入力",
      commands: "音声コマンド",
      recognition: "認識",
      permissions: "権限",
      storage: "ストレージ",
      about: "このアプリについて",
    },
    permissionsWarning: "未許可の権限があります",

    general: {
      language: "言語",
      uiLanguage: "表示言語",
      uiLanguageSub: "話す言語は「認識」で設定します",
      system: "システムに合わせる",
      behavior: "動作",
      launchAtLogin: "ログイン時に起動",
      panel: "パネル",
      compact: "コンパクト表示",
      compactSub: "音声入力パネルをマイクのボタンだけにします。右クリックメニューからも切り替えられます",
    },

    voice: {
      inputModeHelp: "周りに人がいる・会話が聞こえる場所では、1回ずつ聞き取るにすると関係のない声を入力しません",
      autoSubmit: "自動送信",
      autoSubmitSub: "話し終わって入力した後に送信キーを押します。音声コマンドや、何も入力しなかった時は送りません",
      autoSubmitKey: "送信キー",
      microphone: "マイク",
      systemDefault: "システムの既定",
      systemDefaultWith: (name: string) => `システムの既定（${name}）`,
      disconnected: "選択中のマイク（接続されていません）",
      inputLevel: "入力レベル",
      sensitivity: "発話検出の感度",
      sensitivityHelp:
        "高くすると小さな声も拾います。周囲がうるさい場合は下げてください。入力レベルのトラックが薄い青に変わる位置が検出のしきい値です",
      low: "低い",
      high: "高い",
      silence: "話し終わりと判定するまでの無音",
      silenceHelp: "短くすると早く入力されますが、息継ぎで文が途切れやすくなります",
      excludedApps: "入力しないアプリ",
      excludedAppsHelp:
        "パスワード管理アプリやターミナルなど、誤入力を避けたいアプリを登録します。前面にある間は入力せず、パネルに「このアプリには入力しません」と表示します",
      removeApp: (name: string) => `${name} を削除`,
      noApps: "登録したアプリはありません",
      addApp: "アプリを追加",
      runningApps: "起動中のアプリ",
      loadingApps: "読み込んでいます…",
      noCandidates: "追加できるアプリはありません",
    },

    commands: {
      enable: "音声コマンドを使う",
      enableSub: "発話全体が登録した言い方と一致したときだけ、キー操作として送ります。",
      phrases: "言い方",
      key: "送るキー",
      edit: "編集",
      delete: "削除",
      add: "コマンドを追加",
      // example は話す言語の例 (COMMAND_EXAMPLES)
      note: (example: string) => `「${example}」のように前後に言葉があると、通常の文字として入力されます。`,
      addTitle: "コマンドを追加",
      editTitle: "コマンドを編集",
      dialogDescription: "言い方は読点で区切って複数登録できます。",
      /** 編集欄で言い方をつなぐ区切り (splitPhrases は 、 , ， 改行で分ける) */
      phraseJoiner: "、",
      modifiers: "修飾キー",
      keyName: "キー",
      keyPreview: "送るキー:",
      validation: {
        empty: "言い方を入力してください",
        symbolsOnly: (p: string) => `「${p}」は記号や空白だけのため使えません`,
        duplicate: (p: string) => `「${p}」が重複しています`,
        equivalent: (a: string, b: string) => `「${a}」と「${b}」は同じ言い方とみなされます`,
        conflict: (p: string, key: string, hit: string) => `「${p}」は他のコマンド（${key}）の「${hit}」と重複しています`,
      },
    },

    recognition: {
      checking: "確認中",
      loading: "読み込み中",
      loadingSub: "モデルを読み込んでいます",
      stopped: "停止中",
      stoppedSub: "文字起こしサーバーが停止しています",
      missing: "未導入",
      missingSub: "実行環境とモデルがありません",
      loaded: "読み込み済み",
      // Windows は GPU の判定結果 (runningOn・runningOnCpu) が届くまでの表示
      loadedSub: { macos: "Apple Silicon GPU で実行中", windows: "GPU で実行中" } satisfies PerOs<string>,
      /** device は GPU の名前 (GpuStatus.selected) */
      runningOn: (device: string) => `${device} で実行中`,
      runningOnCpu: "CPU で実行中",
      gpuUnavailable: "GPU を使えません",
      gpuUnavailableSub: "GPU が見つからないため、文字起こしを開始していません",
      speechLanguage: "話す言語",
      speechLanguageHelp:
        "文字起こしする言語です。おすすめのモデルと、音声コマンドの既定の言い方 (変更していない場合) もこの言語に合わせます",
      context: "認識のヒント",
      contextHelp:
        "書いた内容は文字起こしのモデルにそのまま渡されます。話す話題や、用語の表記（読み方を添えて）を書くと、その表記で認識されやすくなります。長いほど認識が遅くなります",
      contextPlaceholder: "例: 開発の話です。以下の用語は英字で表記する: Claude Code (読み: クロードコード), pnpm",
      contextOver: (max: number, over: number) => `${max} 文字を超えています（${over} 文字オーバー）`,
    },

    models: {
      heading: "モデル",
      help: "文字起こしに使うモデルです。切り替えるとモデルを読み込み直し、その間は音声入力がオフになります",
      setupIncomplete: "セットアップが完了するまで、モデルの切り替えやダウンロードはできません。",
      recommended: "推奨",
      /** language は表示言語で書いた言語名 (languageName) */
      tunedFor: (language: string) => `${language}向けに調整`,
      inUse: "使用中",
      switching: "切り替えています…",
      use: "使う",
      downloadingElsewhere: "他のモデルをダウンロード中です。同時にダウンロードできるのは 1 つです",
      inUseCantDelete: "使用中のモデルは削除できません。他のモデルに切り替えてから削除してください",
      downloaded: "ダウンロード済み",
      notDownloaded: "未ダウンロード",
      paused: "一時停止中",
      failed: "失敗",
      etaCalculating: "残り時間を計算しています",
      progress: (name: string) => `${name} のダウンロード`,
      cancel: "中止",
      deleteTitle: "モデルを削除しますか？",
      deleteDescription: (name: string, size: string) =>
        `「${name}」（${size}）を削除します。再び使うときはダウンロードし直します。`,
      /** 話す言語の推奨モデルを使っていない時の案内。language は表示言語で書いた言語名 */
      recommendation: (language: string, name: string) => `${language}には「${name}」をおすすめします`,
      recommendationDownloading: "ダウンロードが終わると切り替えられます",
      switchTo: "切り替える",
    },

    permissions: {
      microphone: "マイク",
      microphoneSub: "発話を聞き取るために使います",
      accessibility: "アクセシビリティ",
      accessibilitySub: "文字とキー操作の入力に使います",
      micNotDetermined: "マイクの使用がまだ許可されていません。許可すると音声入力を使えます。",
      micDenied: {
        macos:
          "許可されていないため、音声を聞き取れません。システム設定 > プライバシーとセキュリティ > マイク で mukuchi をオンにしてください。",
        windows:
          "許可されていないため、音声を聞き取れません。Windows の設定 > プライバシーとセキュリティ > マイク で「マイクへのアクセス」と「デスクトップ アプリがマイクにアクセスできるようにする」をオンにしてください。",
      } satisfies PerOs<string>,
      accessibilityDenied:
        "許可されていないため、文字起こしはできますが入力できません。システム設定 > プライバシーとセキュリティ > アクセシビリティ で mukuchi をオンにしてください。",
    },

    storage: {
      runtime: { macos: "Python 実行環境", windows: "実行環境 (llama.cpp)" } satisfies PerOs<string>,
      models: "モデル",
      other: "設定とログ",
      used: "使用中",
      runtimeMissing: "実行環境とモデルがありません。音声入力を使うには、セットアップでダウンロードし直してください。",
      deleteRuntime: "実行環境とモデルのみ削除",
      deleteRuntimeSub: "設定は残ります。再び使うにはセットアップが必要です。",
      uninstall: "完全にアンインストール",
      // Windows はアンインストーラーを起動してアプリを終了する (docs/architecture.md「同梱物・配布 (Windows)」)
      uninstallSub: {
        macos: "すべてのデータとアプリ本体を削除します。",
        windows: "アンインストーラーを起動して、すべてのデータとアプリ本体を削除します。",
      } satisfies PerOs<string>,
      uninstallEllipsis: "アンインストール…",
      deleteRuntimeTitle: "実行環境とモデルを削除しますか？",
      deleteRuntimeDescription: "音声入力は使えなくなります。設定とログは残ります。再び使うときはセットアップからダウンロードし直します。",
      uninstallTitle: "mukuchi を完全にアンインストールしますか？",
      uninstallDone: "アンインストールしました。アプリを終了します。",
      uninstallRunning: {
        macos: "アンインストールしています… 完了するとアプリが終了します。",
        windows: "アンインストーラーを起動しています… アプリは終了します。",
      } satisfies PerOs<string>,
      uninstallConfirm: "以下を削除します。この操作は取り消せません。",
      uninstallButton: "アンインストール",
      uninstallCount: {
        macos: (count: number) => `${count} 項目（ログイン項目と権限の許可も解除します）`,
        windows: (count: number) => `${count} 項目（ログイン時の起動の登録も解除します）`,
      },
      uninstallTotal: (size: string) => `合計 ${size}`,
    },

    about: {
      version: (version: string, build: string) => `バージョン ${version}（build ${build}）`,
      license: "ライセンス",
      show: "表示",
      logs: "ログ",
      showInFolder: { macos: "Finder で開く", windows: "エクスプローラーで開く" } satisfies PerOs<string>,
      updates: "アップデート",
      install: "再起動してアップデート",
      check: "アップデートを確認",
      autoCheck: "自動でアップデートを確認",
      autoCheckSub: "起動時と 6 時間ごとに確認し、新しいバージョンをダウンロードしておきます",
      unavailable: "自動アップデートは使えません",
      upToDate: "最新のバージョンです",
      lastChecked: (when: string) => `最終確認 ${when}`,
      notChecked: "まだ確認していません",
      current: (version: string) => `現在のバージョン ${version}`,
      checking: "アップデートを確認しています…",
      downloading: (version: string | null) =>
        version ? `${version} をダウンロードしています` : "アップデートをダウンロードしています",
      downloadProgress: "アップデートのダウンロード",
      ready: (version: string | null) => (version ? `${version} の準備ができました` : "アップデートの準備ができました"),
      readySub: (current: string) => `再起動するとアップデートします（現在 ${current}）`,
      installing: (version: string | null) =>
        version ? `${version} をインストールしています…` : "アップデートをインストールしています…",
      installingSub: "完了すると自動で再起動します",
      failed: (version: string | null) =>
        version ? `${version} へのアップデートに失敗しました` : "アップデートの確認に失敗しました",
    },
  },
};

export type Messages = typeof ja;
