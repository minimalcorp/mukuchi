/*
 * phase の分類。パネル・設定・セットアップで ON の判定を揃える (docs/architecture.md「録音開始の準備中」)。
 */
import type { Phase } from "./ipc";

// starting (準備中) も ON。押下・ボタンで OFF にできる
const ON_PHASES: readonly Phase[] = ["starting", "listening", "speaking", "finalizing", "done"];

export const isOnPhase = (phase: Phase): boolean => ON_PHASES.includes(phase);

/**
 * 入力レベルを表示する間。starting は含めない (audio-level は届くが 0 として扱う)。
 * 拾い始めと判断できるまでは、メーターを動かして「もう話せる」と見せない (押してすぐ話すと語頭が欠けうるため)
 */
export const showsInputLevel = (phase: Phase): boolean => isOnPhase(phase) && phase !== "starting";
