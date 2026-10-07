/*
 * 話す言語 (Settings.speechLanguage) で決まる例文。表示言語ではなく話す言語に合わせる
 * (英語の UI で日本語を話す人に、話す言語の例を見せるため)
 */
import type { Locale } from "@/lib/ipc";

/** 動作テストで話してもらう例 */
export const SAMPLE_PHRASES: Record<Locale, string> = {
  ja: "君は無口だね",
  en: "Nice to meet you",
};

/** 音声コマンドの言い方の例 (追加の欄の placeholder)。区切りは表示言語の phraseJoiner */
export const COMMAND_PHRASE_EXAMPLES: Record<Locale, string[]> = {
  ja: ["確定", "エンター"],
  en: ["enter", "confirm"],
};

/** 前後に言葉があるとコマンドにならない例 */
export const COMMAND_SENTENCE_EXAMPLES: Record<Locale, string> = {
  ja: "確定してください",
  en: "press enter now",
};
