/*
 * 表示言語ごとにテストを回すための fixture。
 * appLocale (project の設定) をモックの OS の言語として読み込み前に渡し (src/mock/index.ts)、
 * 文言は辞書 (src/i18n) とモックの文言 (src/mock/texts.ts) から引く。
 * 新規の設定では話す言語も表示言語と同じになるため、発話のデータ (sp) も appLocale のもの
 */
import { test as base } from "@playwright/test";
import type { Locale } from "../src/lib/ipc";
import { ja, type Messages } from "../src/i18n/ja";
import { en } from "../src/i18n/en";
import { MOCK_SPEECH_TEXTS, MOCK_UI_TEXTS, type MockSpeechTexts, type MockUiTexts } from "../src/mock/texts";

export { expect } from "@playwright/test";
export type { Locale, Messages };

export type AppLocaleOptions = { appLocale: Locale };

type Fixtures = {
  /** 表示言語の辞書 */
  m: Messages;
  /** モックが返す Rust 由来の文言 (表示言語) */
  ui: MockUiTexts;
  /** モックの発話・アプリ名 (話す言語) */
  sp: MockSpeechTexts;
  /** スクリーンショットの保存先 (言語ごとのディレクトリ) */
  shot: (name: string) => string;
};

export const MESSAGES: Record<Locale, Messages> = { ja, en };

export const test = base.extend<AppLocaleOptions & Fixtures>({
  appLocale: ["ja", { option: true }],
  page: async ({ page, appLocale }, provide) => {
    await page.addInitScript((locale) => {
      (window as { __MUKUCHI_MOCK_LOCALE__?: string }).__MUKUCHI_MOCK_LOCALE__ = locale;
    }, appLocale);
    await provide(page);
  },
  m: async ({ appLocale }, provide) => provide(MESSAGES[appLocale]),
  ui: async ({ appLocale }, provide) => provide(MOCK_UI_TEXTS[appLocale]),
  sp: async ({ appLocale }, provide) => provide(MOCK_SPEECH_TEXTS[appLocale]),
  shot: async ({ appLocale }, provide) => provide((name: string) => `e2e/screenshots/${appLocale}/${name}.png`),
});
