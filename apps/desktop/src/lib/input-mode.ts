import type { InputMode } from "./ipc";

/**
 * 入力モードの並び。名前・説明・向いている場面・ショートカットの説明は辞書の inputMode
 * (セットアップと設定で同じ言葉を使う)
 */
export const INPUT_MODE_IDS: readonly InputMode[] = ["continuous", "oneShot"];
