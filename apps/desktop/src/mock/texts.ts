/*
 * モックが返す、Rust・OS・利用者に由来する文言 (表示言語・話す言語ごと)。
 * Rust の文言は Rust の辞書が正で、ここは画面の確認用の代わり (同じ文言である必要はない)。
 * Playwright からも読むため、ここでは型以外を import しない
 */
import type { AppErrorCode, Locale, VoiceCommand } from "@/lib/ipc";

type ModelText = { name: string; description: string };

/** 表示言語で決まる文言 (Rust が表示言語で作るもの) */
export type MockUiTexts = {
  errors: Record<AppErrorCode, string>;
  /** 入力できなかった時 (utterance-result の failed) の理由 */
  insertFailedNoAccessibility: string;
  models: Record<"ja-8bit" | "base-1.7b-8bit" | "ja-bf16", ModelText>;
  modelDownloadFailed: string;
  runtimeFailed: string;
  verifyFailed: string;
  reject: {
    unknownModel: string;
    setupIncomplete: string;
    switching: string;
    notDownloaded: string;
    inUse: string;
    downloadingCantDelete: string;
    alreadyDownloaded: string;
    otherDownloading: string;
    noUpdate: string;
    shortcut: (shortcut: string) => string;
    asrContextMax: (max: number) => string;
  };
  shortcutConflict: (shortcut: string) => string;
  updateUnavailable: string;
  updateError: string;
  updateNotes: string;
};

/** 話す言語・OS の言語で決まるデータ (発話・アプリ名・マイク名・既定の音声コマンド等) */
export type MockSpeechTexts = {
  /** 代表の発話 (確定結果) */
  text: string;
  /** text の途中表示 */
  partial: string;
  /** 2 つ目の発話 */
  second: string;
  secondPartial: string;
  /** 長い発話 (3 行を超える) */
  long: string;
  /** 音声コマンドとして話した言葉と送ったキー */
  command: string;
  /** 動作テストで入力される文 */
  testSentence: string;
  /** アプリの名前 (OS の言語) */
  notes: string;
  terminal: string;
  builtInMic: string;
  usbMic: string;
  voiceCommands: VoiceCommand[];
  asrContext: string;
};

export const MOCK_UI_TEXTS: Record<Locale, MockUiTexts> = {
  ja: {
    errors: {
      accessibility_denied: "アクセシビリティが許可されていません",
      microphone_denied: "マイクが許可されていません",
      microphone_missing: "マイクが見つかりません",
      asr_stopped: "文字起こしサーバーが停止しました",
      runtime_missing: "実行環境とモデルがありません",
      insert_failed: "入力できませんでした",
      vad_failed: "発話検出を開始できません",
    },
    insertFailedNoAccessibility: "アクセシビリティが未許可のため入力できません",
    models: {
      "ja-8bit": { name: "日本語 (8bit)", description: "日本語向けに追加学習したモデル。英語も認識できます" },
      "base-1.7b-8bit": { name: "標準 (8bit)", description: "追加学習していない元のモデル。日本語・英語を含む多くの言語を認識できます" },
      "ja-bf16": { name: "日本語 (bf16)", description: "量子化していない元のモデル。容量とメモリの使用量 (約8.5GB) が大きい" },
    },
    modelDownloadFailed: "モデルのダウンロードに失敗しました。ネットワーク接続を確認してください。",
    runtimeFailed: "実行環境を導入できませんでした。",
    verifyFailed: "動作確認に失敗しました。",
    reject: {
      unknownModel: "不明なモデルです",
      setupIncomplete: "セットアップが完了していません",
      switching: "モデルを切り替え中です",
      notDownloaded: "ダウンロードが済んでいないモデルは選べません",
      inUse: "使用中のモデルは削除できません",
      downloadingCantDelete: "ダウンロード中のモデルは削除できません。中止してください",
      alreadyDownloaded: "ダウンロード済みです",
      otherDownloading: "他のモデルをダウンロード中です",
      noUpdate: "インストールできるアップデートがありません",
      shortcut: (s) => `ショートカット「${s}」を登録できませんでした。別のキーに変更してください`,
      asrContextMax: (max) => `認識のヒントは${max}文字以内にしてください`,
    },
    shortcutConflict: (s) => `ショートカット「${s}」を登録できませんでした。別のキーに変更してください`,
    updateUnavailable: "アプリケーションフォルダに移動すると自動でアップデートできます",
    updateError: "サーバーに接続できませんでした。ネットワーク接続を確認してください",
    updateNotes: "- 自動アップデートに対応しました\n- 入力モードの切り替えを改善しました",
  },
  en: {
    errors: {
      accessibility_denied: "Accessibility access isn’t allowed",
      microphone_denied: "Microphone access isn’t allowed",
      microphone_missing: "No microphone found",
      asr_stopped: "The transcription server stopped",
      runtime_missing: "The runtime and model aren’t installed",
      insert_failed: "Couldn’t type the text",
      vad_failed: "Couldn’t start speech detection",
    },
    insertFailedNoAccessibility: "Can’t type because Accessibility access isn’t allowed",
    models: {
      "ja-8bit": { name: "Japanese (8-bit)", description: "Fine-tuned for Japanese. Also recognizes English" },
      "base-1.7b-8bit": {
        name: "Standard (8-bit)",
        description: "The original model without extra training. Recognizes many languages, including English and Japanese",
      },
      "ja-bf16": { name: "Japanese (bf16)", description: "The unquantized original. Uses more disk space and memory (about 8.5 GB)" },
    },
    modelDownloadFailed: "Couldn’t download the model. Check your network connection.",
    runtimeFailed: "Couldn’t install the runtime.",
    verifyFailed: "Verification failed.",
    reject: {
      unknownModel: "Unknown model",
      setupIncomplete: "Setup isn’t complete",
      switching: "Switching models",
      notDownloaded: "A model that hasn’t been downloaded can’t be selected",
      inUse: "The model in use can’t be deleted",
      downloadingCantDelete: "A downloading model can’t be deleted. Cancel the download first",
      alreadyDownloaded: "Already downloaded",
      otherDownloading: "Another model is downloading",
      noUpdate: "There’s no update to install",
      shortcut: (s) => `Couldn’t register the shortcut “${s}”. Choose a different key`,
      asrContextMax: (max) => `Recognition hints must be ${max} characters or fewer`,
    },
    shortcutConflict: (s) => `Couldn’t register the shortcut “${s}”. Choose a different key`,
    updateUnavailable: "Move mukuchi to the Applications folder to update automatically",
    updateError: "Couldn’t connect to the server. Check your network connection",
    updateNotes: "- Added automatic updates\n- Improved switching input modes",
  },
};

export const MOCK_SPEECH_TEXTS: Record<Locale, MockSpeechTexts> = {
  ja: {
    text: "明日の打ち合わせは十時からに変更してください。",
    partial: "明日の打ち合わせは十時からに変更して",
    second: "資料は前日までに共有しておきます。",
    secondPartial: "資料は前日までに共有して",
    long: "二行目以降: 会議室は三階の大会議室に変更になりました。参加者には別途連絡しますので、資料は前日までに共有してください",
    command: "確定",
    testSentence: "君は無口だね。",
    notes: "メモ",
    terminal: "ターミナル",
    builtInMic: "MacBook Pro のマイク",
    usbMic: "USB オーディオ",
    voiceCommands: [
      { id: "confirm", phrases: ["確定", "エンター"], key: { key: "enter", modifiers: [] } },
      { id: "newline", phrases: ["改行"], key: { key: "enter", modifiers: ["shift"] } },
      { id: "send", phrases: ["送信"], key: { key: "enter", modifiers: ["cmd"] } },
    ],
    asrContext: [
      "macOS アプリの開発についての話です。",
      "以下の用語は英字で表記する: mukuchi (読み: むくち), Qwen3-ASR (読み: クウェン、クエン), Tauri (読み: タウリ), Claude Code (読み: クロードコード), pnpm",
    ].join("\n"),
  },
  en: {
    text: "Let’s move tomorrow’s meeting to ten o’clock.",
    partial: "Let’s move tomorrow’s meeting to",
    second: "I’ll share the slides the day before.",
    secondPartial: "I’ll share the slides",
    long: "Line two and beyond: the meeting has moved to the large conference room on the third floor. I’ll contact everyone separately, so please share your materials by the day before",
    command: "enter",
    testSentence: "Nice to meet you.",
    notes: "Notes",
    terminal: "Terminal",
    builtInMic: "MacBook Pro Microphone",
    usbMic: "USB Audio",
    voiceCommands: [
      { id: "confirm", phrases: ["enter"], key: { key: "enter", modifiers: [] } },
      { id: "newline", phrases: ["new line", "line break"], key: { key: "enter", modifiers: ["shift"] } },
      { id: "send", phrases: ["send"], key: { key: "enter", modifiers: ["cmd"] } },
    ],
    asrContext: [
      "This is about developing a macOS app.",
      "Spell these terms as written: mukuchi, Qwen3-ASR, Tauri, Claude Code, pnpm",
    ].join("\n"),
  },
};
