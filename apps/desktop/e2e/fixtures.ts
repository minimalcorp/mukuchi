/*
 * 表示言語ごとにテストを回すための fixture と、テストの分類 (タグ)。
 * appLocale (project の設定) をモックの OS の言語として読み込み前に渡し (src/mock/index.ts)、
 * 文言は辞書 (src/i18n) とモックの文言 (src/mock/texts.ts) から引く。
 * 新規の設定では話す言語も表示言語と同じになるため、発話のデータ (sp) も appLocale のもの
 *
 * タグ (playwright.config.ts の projects が grep で振り分ける):
 * - I18N: en でも回す。UI は言語で共通で辞書の文言を差し替えているだけなので、en は「英語で表示されること」と
 *   「はみ出さないこと」、言語で分岐する所 (推奨モデルの並び・区切り文字・Intl の書式・OFF のピルの幅) だけを確かめる
 * - TIMING: 実時間 (毎フレームの採取・アニメーションの経過) を測る。並列の負荷で揺れないよう最後に 1 worker で回す
 * - SCREENSHOT: pnpm screenshots で撮影する (通常の pnpm test でも確認は行い、撮影だけを省く)
 * - SCREENSHOT_ONLY: 撮影のためだけのテスト。pnpm screenshots でだけ回す
 * - WINDOWS: Windows (appPlatform = windows) の表示。chromium (WebView2 は Chromium) の win-* project でだけ回し、
 *   Mac の project では回さない。それ以外のテストは Mac (appPlatform = macos) で回す
 */
import { test as base, type Page } from "@playwright/test";
import process from "node:process";
import type { Locale } from "../src/lib/ipc";
import type { PerOs, Platform } from "../src/lib/platform";
import { ja, type Messages } from "../src/i18n/ja";
import { en } from "../src/i18n/en";
import { MOCK_SPEECH_TEXTS, MOCK_UI_TEXTS, type MockSpeechTexts, type MockUiTexts } from "../src/mock/texts";

export { expect } from "@playwright/test";
export type { Locale, Messages, PerOs };

export const I18N = "@i18n";
export const TIMING = "@timing";
export const SCREENSHOT = "@screenshot";
export const SCREENSHOT_ONLY = "@screenshot-only";
export const WINDOWS = "@windows";

/** pnpm screenshots (SCREENSHOTS=1) の時だけ撮影する */
export const SCREENSHOTS = Boolean(process.env.SCREENSHOTS);

export type AppLocaleOptions = { appLocale: Locale; appPlatform: Platform };

type SnapOptions = {
  /** 撮影の前に待つ ms (入力レベルの表示・スイッチのつまみの移動など、確認には要らず見た目のためだけの待ち) */
  settleMs?: number;
};

type Fixtures = {
  /** 表示言語の辞書 */
  m: Messages;
  /** モックが返す Rust 由来の文言 (表示言語) */
  ui: MockUiTexts;
  /** モックの発話・アプリ名 (話す言語) */
  sp: MockSpeechTexts;
  /**
   * スクリーンショットを e2e/screenshots/<言語>/<name>.png (Windows は e2e/screenshots/windows/<言語>/<name>.png) に撮る
   * (pnpm screenshots の時だけ。それ以外は何もしない)
   */
  snap: (name: string, opts?: SnapOptions) => Promise<void>;
  /** 辞書の OS ごとの文言 (PerOs) から project の OS のものを取る */
  os: <T>(value: PerOs<T>) => T;
};

export const MESSAGES: Record<Locale, Messages> = { ja, en };

/** 有限の (無限に繰り返さない) アニメーション・トランジションが終わるのを待つ */
export async function settleAnimations(page: Page) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    ),
  );
}

export const test = base.extend<AppLocaleOptions & Fixtures>({
  appLocale: ["ja", { option: true }],
  appPlatform: ["macos", { option: true }],
  page: async ({ page, appLocale, appPlatform }, provide) => {
    await page.addInitScript(
      ({ locale, platform }) => {
        const w = window as { __MUKUCHI_MOCK_LOCALE__?: string; __MUKUCHI_MOCK_PLATFORM__?: string };
        w.__MUKUCHI_MOCK_LOCALE__ = locale;
        w.__MUKUCHI_MOCK_PLATFORM__ = platform;
      },
      { locale: appLocale, platform: appPlatform },
    );
    await provide(page);
  },
  os: async ({ appPlatform }, provide) => provide((value) => value[appPlatform]),
  m: async ({ appLocale }, provide) => provide(MESSAGES[appLocale]),
  ui: async ({ appLocale }, provide) => provide(MOCK_UI_TEXTS[appLocale]),
  sp: async ({ appLocale }, provide) => provide(MOCK_SPEECH_TEXTS[appLocale]),
  snap: async ({ page, appLocale, appPlatform }, provide) =>
    provide(async (name, opts = {}) => {
      if (!SCREENSHOTS) return;
      // 撮影のためだけの待ち (通常のテストでは行わない)
      if (opts.settleMs) await page.waitForTimeout(opts.settleMs);
      // Mac は従来の場所のまま (撮影結果を以前と比べられるように)
      const dir = appPlatform === "windows" ? `e2e/screenshots/windows/${appLocale}` : `e2e/screenshots/${appLocale}`;
      await page.screenshot({ path: `${dir}/${name}.png` });
    }),
});
