/*
 * 入力レベル (audio-level, 約20Hz) の外部ストア。
 * React の state に載せるとパネル全体が 20Hz で再描画されるため、
 * useSyncExternalStore で購読するメーター部分だけを再描画する。
 */
import { useSyncExternalStore } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { onEvent, type AudioLevel } from "./ipc";

// received: レベルを一度でも受け取ったか。受信前は感度から求めた位置に縦線を置く
export type LevelSnapshot = AudioLevel & { received: boolean };

let current: LevelSnapshot = { level: 0, threshold: 0.55, speech: false, received: false };
const listeners = new Set<() => void>();
let unlisten: Promise<UnlistenFn> | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  // 最初の購読者が来た時だけ Tauri のイベントを購読する
  if (!unlisten) {
    unlisten = onEvent("audio-level", (payload) => {
      current = { ...payload, received: true };
      listeners.forEach((l) => l());
    });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && unlisten) {
      const p = unlisten;
      unlisten = null;
      p.then((f) => f());
    }
  };
}

function getSnapshot() {
  return current;
}

export function useAudioLevel(): LevelSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** OFF になった時などにメーターを 0 に戻す */
export function resetAudioLevel() {
  current = { ...current, level: 0, speech: false };
  listeners.forEach((l) => l());
}
