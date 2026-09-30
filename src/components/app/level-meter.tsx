import { cn } from "@/lib/utils";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * 入力レベルのメーター (パネル・設定 > 音声入力)。
 * トラックの地を発話検出のしきい値で左右に塗り分け、バーが右側 (薄い青) に入ると青に変わる。
 * しきい値の位置を縦線ではなく地の境目で示すのは、バーと重なっても境目が隠れないため (デザイン 03)
 */
export function LevelMeter({
  level,
  threshold,
  active,
  className,
  testId,
}: {
  /** 0..1 */
  level: number;
  /** 0..1。トラックの塗り分け位置 */
  threshold: number;
  /** 発話として扱っている間 true (バーを青にする) */
  active: boolean;
  className?: string;
  testId?: string;
}) {
  const split = clamp01(threshold) * 100;
  return (
    <div
      data-testid={testId}
      data-active={active}
      className={cn("relative flex h-1.5 flex-1 overflow-hidden rounded-[3px]", className)}
    >
      <span data-testid={testId && `${testId}-below`} className="bg-meter-track" style={{ width: `${split}%` }} />
      <span className="flex-1 bg-meter-track-over" />
      <div
        className={cn("absolute inset-y-0 left-0 rounded-[3px]", active ? "bg-meter-active" : "bg-meter-idle")}
        style={{ width: `${clamp01(level) * 100}%` }}
      />
    </div>
  );
}
