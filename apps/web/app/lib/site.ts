// LP に載せる数値・版・URL はここだけで管理する。
// 値の根拠は docs/plans/lp-spec.md の「数値・文言」。デザインの仮の値ではなく実装と実測を正とする
// with { type: "json" } は e2e (Playwright が Node で読む) に必要。Node は JSON の名前付き import を許さないため既定の import にする
import tauriConf from "../../../desktop/src-tauri/tauri.conf.json" with { type: "json" };

export const SITE_URL = "https://mukuchi.minimalcorp.com";

export const SITE_NAME = "mukuchi";
export const SITE_TITLE = "mukuchi | 話した言葉だけを、そのまま入力。";
export const SITE_DESCRIPTION =
  "mukuchi は Mac に常駐する音声入力アプリです。マイクが拾った発話だけを検知して文字に起こし、前面のアプリへそのまま入力します。音声認識はすべて端末内で処理します。";

/** GitHub Releases の最新版を指す固定 URL (release.yml が版番号なしの dmg も添付する) */
export const DOWNLOAD_URL =
  "https://github.com/minimalcorp/mukuchi/releases/latest/download/mukuchi_aarch64.dmg";
export const GITHUB_URL = "https://github.com/minimalcorp/mukuchi";

/** GA4 の測定 ID (公開される値)。送信は本番ビルドかつ SITE_URL のホストで開いた時だけ (app/lib/analytics.ts) */
export const GA_MEASUREMENT_ID = "G-C0XCXY11HB";
/** フッターの外部送信の表記から案内する、Google によるデータの使用の説明 */
export const GOOGLE_PARTNER_SITES_URL =
  "https://policies.google.com/technologies/partner-sites?hl=ja";

/**
 * desktop アプリの版 (フッター・ダウンロードの補足・動作環境の表に出す)。手で書かず、ビルド時に desktop の版の元
 * (tauri.conf.json) を読む。desktop のリリースは版上げを main へ push した後に web も配信し直す (release.yml の
 * deploy-web-for-desktop) ため、配信中の LP は常に最新の desktop の版を表示する
 */
export const VERSION = `v${tauriConf.version}`;
export const PRICE = "無料";
/** 署名・公証済み dmg の実測 (v0.1.0: 35.95 MB、v0.1.3: 36.21 MB)。版と違い自動では変わらない。大きく変わったら直す */
export const DMG_SIZE = "36 MB";
/** 既定のモデル minimalcorp/Qwen3-ASR-1.7B-JA-MLX-8bit (2,185,804,096 B)。初回セットアップはこれだけを取得する */
export const MODEL_SIZE = "約 2.2 GB";
export const MODEL_NAME = "Qwen3-ASR 1.7B";
export const SETUP_DURATION = "約 5 分";

/**
 * 音声入力のオン・オフのショートカットの既定 (desktop の Settings.shortcut の既定 "Alt+Space")。
 * キーキャップは 1 キーずつ描くので配列で持つ
 */
export const SHORTCUT_KEYS = ["⌥", "Space"] as const;
/** 文中に書く時の表記 (例: 「⌥Space で 1 回分を入力」) */
export const SHORTCUT = SHORTCUT_KEYS.join("");

export const REQUIREMENTS = {
  os: "macOS 13 Ventura 以降",
  chip: "Apple Silicon（M1 以降）",
  chipVerified: "M1 Max・M3 Pro",
  memory: "16 GB 以上を推奨",
  storage: "空き容量 6 GB 以上",
  model: `${MODEL_NAME}（日本語・${MODEL_SIZE}）`,
} as const;

/** フッターの著作権表示。会社名は COMPANY_URL へのリンクにする */
export const COPYRIGHT_PREFIX = "© 2026";
export const COMPANY_NAME = "株式会社Minimal";
export const COMPANY_URL = "https://minimalcorp.com";

/** ダウンロードボタンの下に出す補足 (PC) */
export const DOWNLOAD_META = `${VERSION} ・ ${PRICE} ・ Apple Silicon（M1 以降）専用 ・ ${DMG_SIZE}`;
/** スマホ版の補足 (幅が狭いのでチップの条件とサイズを省く) */
export const DOWNLOAD_META_SHORT = `${VERSION} ・ ${PRICE} ・ Apple Silicon 専用`;

/** 共有シートに渡す文言 */
export const SHARE_TEXT = "Mac 用の音声入力アプリ mukuchi";
