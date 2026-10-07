/*
 * 対応する言語の表 (docs/architecture.md「言語」)。言語を足す時はここと辞書 (ja.ts を正とした <locale>.ts)、
 * index.ts の MESSAGES に加える。表示言語・話す言語で共通の表 (話す言語を足すのは Rust の MODEL_ORDER 等も要る)
 */
import type { Locale } from "@/lib/ipc";

export const LOCALES = ["ja", "en"] as const satisfies readonly Locale[];

/** 言語名は各言語の自称で出す。どの表示言語でも自分の言語を見つけられるように */
export const LOCALE_AUTONYMS: Record<Locale, string> = { ja: "日本語", en: "English" };

export function isLocale(value: unknown): value is Locale {
  return (LOCALES as readonly unknown[]).includes(value);
}
