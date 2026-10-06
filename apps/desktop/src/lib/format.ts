import type { Messages } from "@/i18n/context";
import type { KeyCombo, Locale, Modifier } from "./ipc";

/** 小数の桁を固定して表示言語の書式で出す (桁区切り・小数点の記号は Intl に任せる) */
function formatNumber(value: number, digits: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

/** バイト数を「2.1 GB」「12 MB」の形にする (数字と単位の間は半角スペース。単位の記号は言語によらない) */
export function formatBytes(bytes: number, locale: Locale): string {
  // 0.5 GB 以上は GB で出す (デザインの「0.9 GB」表記。ダウンロード量の比較がしやすい)
  if (bytes >= 5e8 && bytes < 1e9) return `${formatNumber(bytes / 1e9, 1, locale)} GB`;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  // GB 以上は小数1桁、MB 以下は整数で十分
  const digits = i >= 3 ? 1 : 0;
  return `${formatNumber(v, digits, locale)} ${units[i]}`;
}

/** 分母と同じ単位で「0.9 / 2.4 GB」の形にする */
export function formatBytesPair(done: number, total: number, locale: Locale): string {
  const [unit, div] = total >= 1e9 ? ["GB", 1e9] : total >= 1e6 ? ["MB", 1e6] : ["KB", 1e3];
  const d = div === 1e9 ? 1 : 0;
  return `${formatNumber(done / div, d, locale)} / ${formatNumber(total / div, d, locale)} ${unit}`;
}

/** 残り時間 (「残り約 3 分」)。文言は辞書 (複数形は辞書の側で Intl.PluralRules) */
export function formatEta(seconds: number, t: Messages): string {
  if (seconds < 60) return t.format.etaUnderMinute;
  return t.format.etaMinutes(Math.round(seconds / 60));
}

/** 秒数 (「1.3 秒」)。小数1桁 */
export function formatSeconds(seconds: number, locale: Locale, t: Messages): string {
  return t.format.seconds(formatNumber(seconds, 1, locale));
}

/** UNIX 秒を「今日 14:32」「10月1日 14:32」(en: "Today at 2:32 PM" "Oct 1 at 2:32 PM") の形にする (アップデートの最終確認) */
export function formatCheckedAt(unixSeconds: number, locale: Locale, t: Messages, now: Date = new Date()): string {
  const d = new Date(unixSeconds * 1000);
  const time = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(d);
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return t.format.today(time);
  const date = new Intl.DateTimeFormat(locale, { month: locale === "ja" ? "long" : "short", day: "numeric" }).format(d);
  return t.format.dateTime(date, time);
}

const MOD_LABEL: Record<Modifier, string> = { cmd: "⌘", shift: "Shift", option: "Option", ctrl: "Control" };
const MOD_ORDER: Modifier[] = ["ctrl", "option", "shift", "cmd"];
const KEY_LABEL: Record<KeyCombo["key"], string> = {
  enter: "Enter",
  tab: "Tab",
  escape: "Esc",
  backspace: "Backspace",
};

/** 「⌘ + Enter」「Shift + Enter」の形 (デザインの表記) */
export function formatKeyCombo(combo: KeyCombo): string {
  const mods = MOD_ORDER.filter((m) => combo.modifiers.includes(m)).map((m) => MOD_LABEL[m]);
  return [...mods, KEY_LABEL[combo.key]].join(" + ");
}

export const MODIFIER_LABELS = MOD_LABEL;
export const MODIFIER_ORDER = MOD_ORDER;
export const KEY_LABELS = KEY_LABEL;
