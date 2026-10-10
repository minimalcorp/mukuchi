import type { ReactNode } from "react";
import { env } from "@/lib/env";
import { useOsFeatures } from "@/lib/platform";

/**
 * setup / settings のウィンドウの外枠。
 * 実機ではネイティブのウィンドウ (タイトルバーはオーバーレイ) なので全面に描く。
 * ブラウザでのモック表示ではデザインと同じ角丸・枠・影の箱をキャンバス中央に置く。
 */
export function WindowFrame({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  if (!env.browserFrame) {
    return <div className="relative flex h-full w-full overflow-hidden bg-surface-card">{children}</div>;
  }
  return (
    <div className="flex min-h-full items-center justify-center bg-surface-app p-10">
      <div
        data-testid="window-frame"
        className="relative flex flex-none overflow-hidden rounded-xl border border-line-default bg-surface-card shadow-dialog"
        style={{ width, height }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * 信号機ボタンの位置。実機は macOS が描くので同じ幅の余白だけ取る。
 * モック表示ではデザインと同じグレーの丸を描く。信号機ボタンのない OS (Windows) では何も置かない
 */
export function TrafficLights() {
  const { trafficLights } = useOsFeatures();
  if (!trafficLights) return null;
  if (!env.browserFrame) return <span className="w-[52px] flex-none" aria-hidden />;
  return (
    <span className="flex flex-none items-center gap-2" aria-hidden>
      <span className="size-3 rounded-full bg-gray-300" />
      <span className="size-3 rounded-full bg-gray-300" />
      <span className="size-3 rounded-full bg-gray-300" />
    </span>
  );
}

/** 中央に置く見出しの釣り合いを取るため、信号機ボタンの反対側に同じ幅の余白を取る (信号機ボタンのない OS では取らない) */
export function TrafficLightsBalance() {
  const { trafficLights } = useOsFeatures();
  return trafficLights ? <span className="w-[52px]" /> : null;
}
