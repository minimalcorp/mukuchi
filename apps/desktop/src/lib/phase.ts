/*
 * phase の分類。パネル・設定・セットアップで ON の判定を揃える (docs/architecture.md「録音開始の準備中」)。
 * ON/OFF (押下で何をするか) は AppStatus.on で判定する。phase は OFF の後も確定処理中なら finalizing になるため、phase からは決められない
 */
import type { AppStatus, Phase } from "./ipc";

// ON の間に出る phase。starting (準備中)・no_input (マイクの音が届いていない) も含む
const ON_PHASES: readonly Phase[] = ["starting", "no_input", "listening", "speaking", "finalizing", "done"];

/** phase が ON の間に出るものか (モックが AppStatus.on の既定値を決めるのに使う。表示の ON/OFF は AppStatus.on で判定する) */
export const isOnPhase = (phase: Phase): boolean => ON_PHASES.includes(phase);

/**
 * ON だがマイクの入力がまだ有効でない間 (準備中・無音)。待機中には見せず、OFF と同じ系統の表示にする
 * (「待機中 = マイク入力が有効」に揃え、押してすぐ話して語頭が欠ける・音が届かないのに待ち続けることを防ぐ)
 */
export const isPendingPhase = (phase: Phase): boolean => phase === "starting" || phase === "no_input";

/**
 * 入力レベルを表示する間。ON で、starting・no_input でない時 (audio-level は届くが 0 として扱う)。
 * 拾い始めと判断できるまでは、メーターを動かして「もう話せる」と見せない (押してすぐ話すと語頭が欠けうるため)。
 * OFF の後の確定処理中 (finalizing・on = false) も録音していないので出さない
 */
export const showsInputLevel = (status: AppStatus): boolean =>
  status.on && isOnPhase(status.phase) && !isPendingPhase(status.phase);
