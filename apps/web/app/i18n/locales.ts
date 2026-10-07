import { SITE_URL } from "../lib/site";

// LP の言語の対応表。言語を足す時は、ここと辞書 (app/i18n/<locale>.ts)・ルート (app/routes.ts)・
// 事前生成 (react-router.config.ts) に足す

export const LOCALES = ["ja", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/** 各言語のページのパス。`/` は日本語 (公開時からの URL を変えない) */
export const LOCALE_PATHS: Record<Locale, string> = { ja: "/", en: "/en/" };

/** 言語の切り替えに出す名前。どの言語のページからでも自分の言語を見つけられるよう、各言語の自称で書く */
export const LOCALE_NAMES: Record<Locale, string> = { ja: "日本語", en: "English" };

export const OG_LOCALES: Record<Locale, string> = { ja: "ja_JP", en: "en_US" };

/** hreflang の x-default (どの言語にも当たらない閲覧者に見せるページ) */
export const DEFAULT_LOCALE_FOR_OTHERS: Locale = "en";

export const pageUrl = (locale: Locale) => `${SITE_URL}${LOCALE_PATHS[locale]}`;

export const isLocale = (v: unknown): v is Locale =>
  typeof v === "string" && (LOCALES as readonly string[]).includes(v);

/** ルートの handle に置き、root の Layout が `<html lang>` を決めるのに使う */
export interface LocaleHandle {
  locale: Locale;
}
