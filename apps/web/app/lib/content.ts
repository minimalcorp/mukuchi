import type { IconName } from "../components/ui";

// LP の言語によらない構造 (図の形・モード・デモの型)。文言は app/i18n/{ja,en}.ts

export interface Feature {
  no: string;
  title: string;
  body: string;
  visual: "always" | "vad" | "command";
}

/** アイコン付きの項目 (作業の邪魔をしないための機能・プライバシー) */
export interface IconItem {
  icon: IconName;
  title: string;
  body: string;
}

export interface AlwaysRow {
  icon: IconName;
  k: string;
  v: string;
}

export interface Step {
  no: string;
  title: string;
  body: string;
}

// デザインの VAD の図の高さ (%)。発話区間は青で塗る
const VAD_PATTERN = [
  2, 3, 2, 4, 3, 2, 30, 70, 55, 90, 62, 80, 45, 72, 38, 3, 5, 2, 4, 3, 6, 2, 40, 85, 66, 92, 50, 76,
  58, 4, 2, 3, 10, 4, 2, 3, 60, 82, 48, 70, 3, 2, 4, 2, 3, 2,
];
const isSpeech = (i: number) => (i >= 6 && i <= 14) || (i >= 22 && i <= 28) || (i >= 36 && i <= 39);
export const VAD_BARS = VAD_PATTERN.map((h, i) => ({ h: Math.max(4, h), speech: isSpeech(i) }));

// ---- 入力モード (desktop の Settings.inputMode。docs/architecture.md の「入力モード」) ----

export type InputMode = "always" | "once";

export const INPUT_MODES: readonly InputMode[] = ["always", "once"];

/** 既定のモード (バッジを付ける) */
export const DEFAULT_MODE: InputMode = "always";

export const MODE_ICONS: Record<InputMode, IconName> = { always: "repeat", once: "keyboard" };

/** 波形の棒。h は高さ (%)、speech は発話 (青)、band は聞き取る区間 (背景を塗る) */
export interface WaveBar {
  h: number;
  speech: boolean;
  band: boolean;
}

// デザインの波形の高さ (%)。常に聞き取るは全体が聞き取る区間、1回ずつは押してから話し終わるまでだけ
const ALWAYS_WAVE = [
  3, 4, 3, 5, 3, 4, 40, 72, 55, 88, 62, 80, 45, 70, 4, 3, 5, 3, 4, 3, 50, 84, 66, 90, 58, 74, 40, 3,
  4, 3, 5, 4, 3, 62, 80, 48, 70, 4, 3, 3,
];
const alwaysSpeech = (i: number) =>
  (i >= 6 && i <= 13) || (i >= 20 && i <= 26) || (i >= 33 && i <= 36);
const ONCE_WAVE = [
  30, 52, 40, 60, 44, 36, 58, 30, 4, 3, 3, 4, 3, 40, 72, 55, 88, 62, 80, 45, 70, 66, 50, 4, 3, 3, 4,
  3, 34, 56, 42, 62, 38, 50, 30, 44, 4, 3, 4, 3,
];

export const MODE_BARS: Record<InputMode, WaveBar[]> = {
  always: ALWAYS_WAVE.map((h, i) => ({ h: Math.max(6, h), speech: alwaysSpeech(i), band: true })),
  // 押す前 (0〜7) の会話は聞き取らない。押してから (8〜) 話し終わる (22) までが 1 回分
  once: ONCE_WAVE.map((h, i) => ({
    h: Math.max(6, h),
    speech: i >= 13 && i <= 22,
    band: i >= 8 && i <= 22,
  })),
};

/** モードのカードの文言 */
export interface ModeCardText {
  body: string;
  /** 波形の下の区間の説明。f は幅の比 (波形の区間に合わせる)、t は PC・tSp はスマホの文言、active は聞き取る区間 */
  segs: { f: number; t: string; tSp: string; active: boolean }[];
  when: string[];
  /** ショートカットの動作。キーキャップの後に when、その右 (スマホは下) に does を書く */
  keys: { when: string; does: string }[];
}

// ---- ヒーローのデモ ----

/** パネルの状態。表示する文言は辞書の demo.status */
export type DemoPhase = "off" | "waiting" | "listening" | "recognizing" | "inserted" | "key";

export interface DemoStep {
  phase: DemoPhase;
  /** 音声入力がオン (パネルのマイクが青) */
  on?: boolean;
  speak?: boolean;
  /** オフの間も周りの音でメーターが振れる (聞き取らないことを見せる) */
  noise?: boolean;
  preview?: string;
  input: string;
  sent: string[];
  caption: string;
  chip?: string;
  ms: number;
}

/**
 * 動きを減らす設定 (prefers-reduced-motion) の時に止めて見せる場面 (どちらも入力まで済んだ状態)。
 * モードのタブは押せるので、モードごとに持つ。どの言語の流れも同じ場面の並びにする
 */
export const DEMO_STILL_STEP: Record<InputMode, number> = { always: 5, once: 4 };

/** 型を付けた配列を作る (辞書の型 Messages を typeof ja から作るため、要素の型をここで決める) */
export const list = <T>(items: T[]): T[] => items;

/** 型を付けた対応表を作る (list と同じ理由。キーごとの型に分かれず、値の型がそろう) */
export const record = <K extends string, V>(r: Record<K, V>): Record<K, V> => r;

/** ダウンロードボタンの文言 (判定結果ごと)。label・short はダウンロードできない時だけ (できる時は共通の文言) */
export interface CtaText {
  label?: string;
  short?: string;
  note: string;
}
