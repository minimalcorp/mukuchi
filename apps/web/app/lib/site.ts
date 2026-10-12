// LP に載せる数値・版・URL はここだけで管理する。
// 値の根拠は docs/plans/lp-spec.md の「数値・文言」。デザインの仮の値ではなく実装と実測を正とする
// with { type: "json" } は e2e (Playwright が Node で読む) に必要。Node は JSON の名前付き import を許さないため既定の import にする
import tauriConf from "../../../desktop/src-tauri/tauri.conf.json" with { type: "json" };

export const SITE_URL = "https://mukuchi.minimalcorp.com";

export const SITE_NAME = "mukuchi";

/** 対応する OS。OS ごとに変わる値 (ダウンロード・キー表記・モデルの容量) はこの型で引く */
export type Os = "macos" | "windows";
export const OSES: readonly Os[] = ["macos", "windows"];

/**
 * Windows 版を公開しているか。Windows の Release が公開されて mukuchi_x64-setup.exe が実在してから true にして
 * LP を deploy する (リンク切れのボタンを出さない。docs/plans/windows-plan.md §10.1)。
 * false の間は Windows の主ボタンを「準備中」にする。OS 中立の文言はこの値に関係なく出す
 */
export const WINDOWS_AVAILABLE = true;

/** GitHub Releases の最新版を指す固定 URL (release.yml が版番号なしの成果物も添付する) */
export const DMG_URL =
  "https://github.com/minimalcorp/mukuchi/releases/latest/download/mukuchi_aarch64.dmg";
export const NSIS_URL =
  "https://github.com/minimalcorp/mukuchi/releases/latest/download/mukuchi_x64-setup.exe";
export const GITHUB_URL = "https://github.com/minimalcorp/mukuchi";

/** GA4 の測定 ID (公開される値)。送信は本番ビルドかつ SITE_URL のホストで開いた時だけ (app/lib/analytics.ts) */
export const GA_MEASUREMENT_ID = "G-C0XCXY11HB";
/** フッターの外部送信の表記から案内する、Google によるデータの使用の説明 (表示はページの言語に合わせる) */
export const googlePartnerSitesUrl = (locale: string) =>
  `https://policies.google.com/technologies/partner-sites?hl=${locale}`;

/**
 * desktop アプリの版 (フッター・ダウンロードの補足・動作環境の表に出す)。手で書かず、ビルド時に desktop の版の元
 * (tauri.conf.json) を読む。desktop のリリースは版上げを main へ push した後に web も配信し直す (release.yml の
 * deploy-web-for-desktop) ため、配信中の LP は常に最新の desktop の版を表示する
 */
export const VERSION = `v${tauriConf.version}`;
/** 署名・公証済み dmg の実測 (v0.1.0: 35.95 MB、v0.1.3: 36.21 MB) の MB。版と違い自動では変わらない。大きく変わったら直す */
export const DMG_SIZE_MB = 36;
/** Windows のインストーラー (NSIS、署名なし) の実測 (28,864,743 B) の MB。同梱の llama-server の分だけ dmg と違う */
export const NSIS_SIZE_MB = 29;

/** OS ごとのダウンロード (ボタン・GA の file_download・動作要件の表のリンク) */
export const DOWNLOADS: Record<Os, { url: string; fileName: string; ext: string; sizeMb: number }> =
  {
    macos: { url: DMG_URL, fileName: "mukuchi_aarch64.dmg", ext: "dmg", sizeMb: DMG_SIZE_MB },
    windows: {
      url: NSIS_URL,
      fileName: "mukuchi_x64-setup.exe",
      ext: "exe",
      sizeMb: NSIS_SIZE_MB,
    },
  };

/**
 * ページの言語 (= その言語を話す人) に勧めるモデルを OS ごとに持つ。初回セットアップは話す言語の推奨モデルだけを取得する
 * (docs/architecture.md「モデルの管理」の MODEL_ORDER の先頭)。名前は両 OS で同じ
 */
export const MODELS = {
  macos: {
    /** ja-8bit: minimalcorp/Qwen3-ASR-1.7B-JA-MLX-8bit (2,185,804,096 B、tree API)。日本語向けに追加学習したもの */
    ja: { name: "Qwen3-ASR 1.7B", bytes: 2_185_804_096 },
    /**
     * base-1.7b-8bit: minimalcorp/Qwen3-ASR-1.7B-MLX-8bit (2,174,372,462 B、tree API)。Qwen/Qwen3-ASR-1.7B を
     * 全層 8bit に変換したもの。追加学習なしの元のモデル
     */
    en: { name: "Qwen3-ASR 1.7B", bytes: 2_174_372_462 },
  },
  // Windows は GGUF (LLM Q8_0 + mmproj Q8_0 の 2 ファイル)。容量は desktop の CATALOG (provisioning/models.rs) の値
  windows: {
    /** ja-gguf: minimalcorp/Qwen3-ASR-1.7B-JA-GGUF (2,190,132,448 B) */
    ja: { name: "Qwen3-ASR 1.7B", bytes: 2_190_132_448 },
    /** base-gguf: minimalcorp/Qwen3-ASR-1.7B-GGUF (2,520,744,384 B)。元のモデル */
    en: { name: "Qwen3-ASR 1.7B", bytes: 2_520_744_384 },
  },
} as const satisfies Record<Os, Record<"ja" | "en", { name: string; bytes: number }>>;

/** セットアップの所要時間 (分)。モデルのダウンロードを含む */
export const SETUP_MINUTES = 5;

/** OS ごとのキー表記 (desktop の表示に合わせる。Mac は記号、Windows は Ctrl / Alt / Shift / Win) */
export interface OsKeys {
  /** 音声入力のオン・オフのショートカットの既定 (desktop の Settings.shortcut の既定 "Alt+Space"、両 OS 共通)。
   * キーキャップは 1 キーずつ描くので配列で持つ */
  shortcutKeys: readonly [string, string];
  /** 文中に書く時の表記 (例: 「⌥Space で 1 回分を入力」) */
  shortcut: string;
  /** 音声コマンド「改行」のキー */
  newline: string;
  /** 音声コマンド「送信」のキー (既定の送信キーは Mac ⌘+Enter、Windows Ctrl+Enter) */
  send: string;
}

export const KEYS: Record<Os, OsKeys> = {
  macos: {
    shortcutKeys: ["⌥", "Space"],
    shortcut: "⌥Space",
    newline: "⇧ + Enter",
    send: "⌘ + Enter",
  },
  windows: {
    shortcutKeys: ["Alt", "Space"],
    shortcut: "Alt+Space",
    newline: "Shift + Enter",
    send: "Ctrl + Enter",
  },
};

/** フッターの著作権表示。会社名 (辞書) は COMPANY_URL へのリンクにする */
export const COPYRIGHT_PREFIX = "© 2026";
export const COMPANY_URL = "https://minimalcorp.com";

/**
 * GB・MB の数値を言語の書式で整形する (単位と「約」などの語は辞書側で付ける)。
 * 単位まで Intl に任せると、ICU の版で空白の文字が変わり事前生成の HTML とハイドレーションが食い違いうるため数値だけにする
 */
export const formatGb = (locale: string, bytes: number) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1e9);
