import { useLevelEnvelope } from "@/lib/level-envelope";
import { cn } from "@/lib/utils";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * 入力レベルのメーター (パネル・設定 > 音声入力)。
 * トラックの地を発話検出のしきい値で左右に塗り分け、バーが右側 (薄い青) に入ると青に変わる。
 * しきい値の位置を縦線ではなく地の境目で示すのは、バーと重なっても境目が隠れないため (デザイン 03)
 *
 * バーの長さは平滑化する (useLevelEnvelope)。色 (active) は平滑化せず受け取った値で切り替える:
 * 感度を合わせる時に「今しきい値を超えているか」がすぐ分かるように。下がる時のバーはゆっくり縮むため、
 * 超えなくなった瞬間はまだ境目より右でグレーになるが、色の方が判定を正しく表す。
 * しきい値付近で 15Hz ごとに色が入れ替わってもチラつかないよう、色は transition-control (120ms) で変える
 */
export function LevelMeter({
  level,
  threshold,
  active,
  disabled = false,
  className,
  testId,
}: {
  /** 0..1 */
  level: number;
  /** 0..1。トラックの塗り分け位置 */
  threshold: number;
  /** 発話として扱っている間 true (バーを青にする) */
  active: boolean;
  /** 音を拾えていない間 (準備中) true。薄く出し、話せる状態ではないと分かるようにする (レベルは呼び出し側で 0 にする) */
  disabled?: boolean;
  className?: string;
  testId?: string;
}) {
  const split = clamp01(threshold) * 100;
  const barRef = useLevelEnvelope<HTMLDivElement>(level);
  return (
    <div
      data-testid={testId}
      data-active={active}
      data-disabled={disabled}
      className={cn(
        "relative flex h-1.5 flex-1 overflow-hidden rounded-[3px] transition-opacity duration-(--duration-fast) ease-standard",
        disabled && "opacity-40",
        className,
      )}
    >
      <span data-testid={testId && `${testId}-below`} className="bg-meter-track" style={{ width: `${split}%` }} />
      <span className="flex-1 bg-meter-track-over" />
      <div
        ref={barRef}
        data-testid={testId && `${testId}-bar`}
        className={cn(
          "absolute inset-y-0 left-0 rounded-[3px] transition-control",
          active ? "bg-meter-active" : "bg-meter-idle",
        )}
      />
    </div>
  );
}
