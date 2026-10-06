// LP に載せる数値・版・URL はここだけで管理する。
// 値の根拠は docs/plans/lp-spec.md の「数値・文言」。デザインの仮の値ではなく実装と実測を正とする
// with { type: "json" } は e2e (Playwright が Node で読む) に必要。Node は JSON の名前付き import を許さないため既定の import にする
import tauriConf from "../../../desktop/src-tauri/tauri.conf.json" with { type: "json" };

export const SITE_URL = "https://mukuchi.minimalcorp.com";

export const SITE_NAME = "mukuchi";

/** GitHub Releases の最新版を指す固定 URL (release.yml が版番号なしの dmg も添付する) */
export const DOWNLOAD_URL =
  "https://github.com/minimalcorp/mukuchi/releases/latest/download/mukuchi_aarch64.dmg";
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

/**
 * ページの言語 (= その言語を話す人) に勧めるモデル。初回セットアップは話す言語の推奨モデルだけを取得する
 * (docs/architecture.md「モデルの管理」の MODEL_ORDER の先頭)。容量は固定した revision の tree API の値
 */
export const MODELS = {
  /** ja-8bit: minimalcorp/Qwen3-ASR-1.7B-JA-MLX-8bit (2,185,804,096 B)。日本語向けに追加学習したもの */
  ja: { name: "Qwen3-ASR 1.7B", bytes: 2_185_804_096 },
  /**
   * base-1.7b-8bit: minimalcorp/Qwen3-ASR-1.7B-MLX-8bit (2,174,372,462 B)。Qwen/Qwen3-ASR-1.7B を全層 8bit に
   * 変換したもの。追加学習なしの元のモデル
   */
  en: { name: "Qwen3-ASR 1.7B", bytes: 2_174_372_462 },
} as const;

/** セットアップの所要時間 (分)。モデルのダウンロードを含む */
export const SETUP_MINUTES = 5;

/**
 * 音声入力のオン・オフのショートカットの既定 (desktop の Settings.shortcut の既定 "Alt+Space")。
 * キーキャップは 1 キーずつ描くので配列で持つ
 */
export const SHORTCUT_KEYS = ["⌥", "Space"] as const;
/** 文中に書く時の表記 (例: 「⌥Space で 1 回分を入力」) */
export const SHORTCUT = SHORTCUT_KEYS.join("");

/** フッターの著作権表示。会社名 (辞書) は COMPANY_URL へのリンクにする */
export const COPYRIGHT_PREFIX = "© 2026";
export const COMPANY_URL = "https://minimalcorp.com";

/**
 * GB・MB の数値を言語の書式で整形する (単位と「約」などの語は辞書側で付ける)。
 * 単位まで Intl に任せると、ICU の版で空白の文字が変わり事前生成の HTML とハイドレーションが食い違いうるため数値だけにする
 */
export const formatGb = (locale: string, bytes: number) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1e9);
