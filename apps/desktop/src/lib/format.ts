import type { KeyCombo, Modifier } from "./ipc";

/** バイト数を「2.1 GB」「12 MB」の形にする (数字と単位の間は半角スペース) */
export function formatBytes(bytes: number): string {
  // 0.5 GB 以上は GB で出す (デザインの「0.9 GB」表記。ダウンロード量の比較がしやすい)
  if (bytes >= 5e8 && bytes < 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  // GB 以上は小数1桁、MB 以下は整数で十分
  const digits = i >= 3 ? 1 : 0;
  return `${v.toFixed(digits)} ${units[i]}`;
}

/** 分母と同じ単位で「0.9 / 2.4 GB」の形にする */
export function formatBytesPair(done: number, total: number): string {
  const [unit, div] = total >= 1e9 ? ["GB", 1e9] : total >= 1e6 ? ["MB", 1e6] : ["KB", 1e3];
  const d = div === 1e9 ? 1 : 0;
  return `${(done / div).toFixed(d)} / ${(total / div).toFixed(d)} ${unit}`;
}

export function formatEta(seconds: number): string {
  if (seconds < 60) return "残り 1 分未満";
  return `残り約 ${Math.round(seconds / 60)} 分`;
}

/** UNIX 秒を「今日 14:32」「10月1日 14:32」の形にする (アップデートの最終確認) */
export function formatCheckedAt(unixSeconds: number, now: Date = new Date()): string {
  const d = new Date(unixSeconds * 1000);
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? `今日 ${time}` : `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
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
