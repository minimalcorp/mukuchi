/*
 * グローバルショートカットの文字列 (Settings.shortcut) の表示と、キー入力からの組み立て。
 * 形式は docs/architecture.md の Settings.shortcut: 「修飾+…+キー」(修飾は Ctrl・Alt・Shift・Cmd をこの順、キーは KeyboardEvent.code)。
 * 形式は OS によらず同じで、表示だけ OS の作法に合わせる (Mac は ⌃⌥⇧⌘ の記号、Windows は Ctrl・Alt・Shift・Win。Cmd は Win キー)。
 */
import type { PerOs, Platform } from "./platform";

const MODIFIERS = ["Ctrl", "Alt", "Shift", "Cmd"] as const;
type ShortcutModifier = (typeof MODIFIERS)[number];

/** Mac はメニューと同じ記号 (並びも ⌃⌥⇧⌘ の順)。Windows はキーの刻印の名前 */
const MODIFIER_SYMBOL: PerOs<Record<ShortcutModifier, string>> = {
  macos: { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Cmd: "⌘" },
  windows: { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Cmd: "Win" },
};

/** Mac はメニューと同じ記号、Windows はキーの名前。ここにないキーは両 OS で共通 (KEY_LABEL_COMMON) */
const KEY_LABEL: PerOs<Record<string, string>> = {
  macos: {
    Enter: "↩",
    Tab: "⇥",
    Backspace: "⌫",
    Delete: "⌦",
    Escape: "⎋",
    Home: "↖",
    End: "↘",
    PageUp: "⇞",
    PageDown: "⇟",
  },
  windows: {
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Escape: "Esc",
    Home: "Home",
    End: "End",
    PageUp: "PgUp",
    PageDown: "PgDn",
  },
};

const KEY_LABEL_COMMON: Record<string, string> = {
  Space: "Space",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
};

/** Rust (global-hotkey のパーサ) が受け付けないキー。保存すると登録できないため記録の時点で断る */
const UNSUPPORTED_CODES = new Set(["IntlYen", "IntlRo"]);

/** 修飾キー単体の code。これだけでは組み合わせにならないため、記録中は次のキーを待つ */
const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "CapsLock",
  "Fn",
  "FnLock",
]);

function keyLabel(code: string, platform: Platform): string {
  const label = KEY_LABEL[platform][code] ?? KEY_LABEL_COMMON[code];
  if (label) return label;
  const m = /^(?:Key|Digit)(.)$/.exec(code) ?? /^Numpad(\d)$/.exec(code);
  if (m) return m[1];
  return code;
}

/** 表示用の部品 ("Alt+Space" → Mac ["⌥", "Space"]、Windows ["Alt", "Space"])。キーを kbd で1つずつ囲んで出すため */
export function shortcutParts(shortcut: string, platform: Platform): string[] {
  const tokens = shortcut.split("+");
  const key = tokens.pop() ?? "";
  const symbols = MODIFIER_SYMBOL[platform];
  const mods = tokens.map((t) => symbols[t as ShortcutModifier] ?? t);
  return [...mods, keyLabel(key, platform)];
}

/** 文章中の部品の区切り。Windows はキーの名前を + でつなぐ書き方 (Ctrl+Alt+Space) が一般的 */
const PARTS_JOINER: PerOs<string> = { macos: " ", windows: "+" };

/** 文章中の表示 ("Alt+Space" → Mac "⌥ Space"、Windows "Alt+Space") */
export function formatShortcut(shortcut: string, platform: Platform): string {
  return shortcutParts(shortcut, platform).join(PARTS_JOINER[platform]);
}

/** 押している修飾キー (Settings.shortcut の順) */
export function eventModifiers(e: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): ShortcutModifier[] {
  const held: Record<ShortcutModifier, boolean> = { Ctrl: e.ctrlKey, Alt: e.altKey, Shift: e.shiftKey, Cmd: e.metaKey };
  return MODIFIERS.filter((m) => held[m]);
}

/** 押している修飾キーの記号 (記録中に「⌥ …」と出す) */
export function modifierSymbols(mods: ShortcutModifier[], platform: Platform): string[] {
  return mods.map((m) => MODIFIER_SYMBOL[platform][m]);
}

export type RecordedKey =
  /** 修飾キーだけ (まだ組み合わせになっていない) */
  | { kind: "modifier" }
  /** 修飾キーなしの通常キー (グローバルに取ると普段の入力を奪うため受け付けない) */
  | { kind: "no_modifier"; code: string }
  /** ショートカットに使えないキー */
  | { kind: "unsupported"; code: string }
  | { kind: "shortcut"; shortcut: string };

/** 記録中の keydown を Settings.shortcut の形式にする */
export function recordKey(e: Pick<KeyboardEvent, "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): RecordedKey {
  if (!e.code || MODIFIER_CODES.has(e.code)) return { kind: "modifier" };
  const mods = eventModifiers(e);
  if (mods.length === 0) return { kind: "no_modifier", code: e.code };
  if (UNSUPPORTED_CODES.has(e.code)) return { kind: "unsupported", code: e.code };
  return { kind: "shortcut", shortcut: [...mods, e.code].join("+") };
}
