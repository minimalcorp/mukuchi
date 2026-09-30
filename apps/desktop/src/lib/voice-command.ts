/*
 * 音声コマンドの言い方の検証。Rust (src-tauri/src/voice_command.rs の normalize) と同じ正規化で比べる。
 * Rust は先に一致したコマンドを使うため、正規化後に同じになる言い方が複数あると後ろのコマンドは使われない。
 * 保存前にここで重複を弾き、その食い違いを起こさない。
 */
import type { VoiceCommand } from "./ipc";

/** Rust の is_punctuation と同じ範囲 (ASCII の記号・一般句読点・CJK 記号と句読点・中黒・全角形の一部) */
function isPunctuation(cp: number): boolean {
  // char::is_ascii_punctuation: ! 〜 / , : 〜 @, [ 〜 `, { 〜 ~
  if ((cp >= 0x21 && cp <= 0x2f) || (cp >= 0x3a && cp <= 0x40) || (cp >= 0x5b && cp <= 0x60) || (cp >= 0x7b && cp <= 0x7e)) {
    return true;
  }
  return (
    (cp >= 0x2000 && cp <= 0x206f) ||
    (cp >= 0x3000 && cp <= 0x3004) ||
    (cp >= 0x3008 && cp <= 0x3020) ||
    cp === 0x3030 ||
    cp === 0x303d ||
    cp === 0x30fb ||
    (cp >= 0xff5f && cp <= 0xff65)
  );
}

// Rust の char::is_whitespace は Unicode の White_Space プロパティ (JS の \s とは U+FEFF の扱いが違う)
const WHITE_SPACE = /\p{White_Space}/u;

/** NFKC → 空白・句読点を除く → 小文字化 (Rust と同じく 1 文字ずつ小文字にする) */
export function normalizePhrase(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFKC")) {
    const cp = ch.codePointAt(0) ?? 0;
    if (WHITE_SPACE.test(ch) || isPunctuation(cp)) continue;
    out += ch.toLowerCase();
  }
  return out;
}

/** 入力欄の文字列を言い方の配列にする。読点・カンマ・改行で区切る */
export function splitPhrases(input: string): string[] {
  return input
    .split(/[、,，\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * 言い方の検証。問題があれば表示用のメッセージを返す。
 * others は編集中のコマンド以外 (他のコマンドとの重複を調べる)
 */
export function validatePhrases(
  phrases: string[],
  others: VoiceCommand[],
  formatKey: (c: VoiceCommand) => string,
): string | null {
  if (phrases.length === 0) return "言い方を入力してください";
  const seen = new Map<string, string>();
  for (const p of phrases) {
    const n = normalizePhrase(p);
    if (n === "") return `「${p}」は記号や空白だけのため使えません`;
    const dup = seen.get(n);
    if (dup != null) return dup === p ? `「${p}」が重複しています` : `「${dup}」と「${p}」は同じ言い方とみなされます`;
    seen.set(n, p);
    for (const c of others) {
      const hit = c.phrases.find((q) => normalizePhrase(q) === n);
      if (hit != null) return `「${p}」は他のコマンド（${formatKey(c)}）の「${hit}」と重複しています`;
    }
  }
  return null;
}
