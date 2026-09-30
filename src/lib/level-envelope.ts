/*
 * 入力レベルのバーの見た目の平滑化 (ピークメーター風のエンベロープ)。
 * audio-level は約15Hz で届き、そのまま描くと値の飛びがギザギザに見えるため、
 * 上がる時は速く (時定数 50ms)、下がる時はゆっくり (300ms) 追従させる。
 * 表示だけの処理で、発話検出 (Rust の VAD) には影響しない。
 *
 * 15Hz のサンプルの間を補間するにはフレームごとに描く必要があるため、アニメーションとして
 * requestAnimationFrame を使う。毎フレーム React を再描画しないよう、値は要素の style に直接書く
 * (既定は幅。コンパクト表示のリングは大きさ = transform に書く)。
 * 値が追いついたらループを止める (待機中に rAF を回し続けない)。
 */
import { useEffect, useLayoutEffect, useRef } from "react";

const ATTACK_MS = 50;
const RELEASE_MS = 300;
// これ以下の差は追いついたとみなしてループを止める (幅 0.05% 未満は見た目に出ない)
const EPSILON = 0.0005;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

const writeWidth = (el: HTMLElement, v: number) => {
  el.style.width = `${v * 100}%`;
};

/**
 * level (0..1) に追従する値を返した ref の要素に write で書く (既定は幅)。
 * write が書くプロパティ (既定は width) は React の style で指定しないこと
 * (再描画のたびにエンベロープの途中の値が上書きされるため)
 */
export function useLevelEnvelope<T extends HTMLElement>(
  level: number,
  write: (el: T, value: number) => void = writeWidth,
) {
  const ref = useRef<T>(null);
  // rAF のループの途中で呼ぶため最新の関数を ref で持つ (毎回の描画で渡し直されてもループを作り直さない)
  const writeRef = useRef(write);
  useLayoutEffect(() => {
    writeRef.current = write;
  });
  const target = useRef(clamp01(level));
  const current = useRef(clamp01(level));
  const frame = useRef<number | null>(null);
  const lastTime = useRef<number | null>(null);

  // 初回の描画前に今の値を書く (最初のフレームで幅 0 から伸びて見えないように)
  useLayoutEffect(() => {
    if (ref.current) writeRef.current(ref.current, current.current);
  }, []);

  useEffect(() => {
    target.current = clamp01(level);
    if (frame.current != null) return;
    const step = (now: number) => {
      const el = ref.current;
      const dt = lastTime.current == null ? 1000 / 60 : now - lastTime.current;
      lastTime.current = now;
      const diff = target.current - current.current;
      if (Math.abs(diff) < EPSILON) {
        current.current = target.current;
      } else {
        const tau = diff > 0 ? ATTACK_MS : RELEASE_MS;
        current.current += diff * (1 - Math.exp(-dt / tau));
      }
      if (el) writeRef.current(el, current.current);
      if (current.current === target.current) {
        frame.current = null;
        lastTime.current = null;
        return;
      }
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, [level]);

  useEffect(
    () => () => {
      if (frame.current != null) cancelAnimationFrame(frame.current);
      frame.current = null;
    },
    [],
  );

  return ref;
}
