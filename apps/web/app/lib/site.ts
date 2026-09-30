// LP に載せる数値・版・URL はここだけで管理する (リリースのたびにここを直す)。
// 値の根拠は docs/plans/lp-spec.md の「数値・文言」。デザインの仮の値ではなく実装と実測を正とする

export const SITE_URL = "https://mukuchi.minimalcorp.com";

export const SITE_NAME = "mukuchi";
export const SITE_TITLE = "mukuchi | 話した言葉だけを、そのまま入力。";
export const SITE_DESCRIPTION =
  "mukuchi は Mac に常駐する音声入力アプリです。マイクが拾った発話だけを検知して文字に起こし、前面のアプリへそのまま入力します。音声認識はすべて端末内で処理します。";

/** GitHub Releases の最新版を指す固定 URL (release.yml が版番号なしの dmg も添付する) */
export const DOWNLOAD_URL =
  "https://github.com/minimalcorp/mukuchi/releases/latest/download/mukuchi_aarch64.dmg";
export const GITHUB_URL = "https://github.com/minimalcorp/mukuchi";

export const VERSION = "v0.1.0";
export const PRICE = "無料";
/** 署名・公証済み dmg の実測 (v0.1.0: 35.95 MB) */
export const DMG_SIZE = "36 MB";
/** 現在の配布モデル neosophie/Qwen3-ASR-1.7B-JA。8bit 版 (約 2.2 GB) に切り替えたら更新する */
export const MODEL_SIZE = "約 4.1 GB";
export const SETUP_DURATION = "約 5 分";

export const REQUIREMENTS = {
  os: "macOS 13 Ventura 以降",
  chip: "Apple Silicon（M1 以降）",
  chipVerified: "動作確認: M1 Max・M3 Pro",
  memory: "16 GB 以上を推奨",
  storage: "空き容量 6 GB 以上",
  model: "Qwen3-ASR 1.7B（日本語）",
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
