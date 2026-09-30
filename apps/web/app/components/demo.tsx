import { useEffect, useState, useSyncExternalStore } from "react";
import { DEMO_SCRIPT, DEMO_STILL_STEP } from "@/lib/content";
import { Icon } from "./ui";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(onChange: () => void) {
  const mql = window.matchMedia(REDUCED_MOTION);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

/** 事前生成の HTML は動かす前提 (false) で出し、ハイドレーション後に利用者の設定を反映する */
export function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  );
}

/**
 * ヒーローのデモ。発話→入力→音声コマンドの流れを繰り返す。
 * 利用者が動きを減らす設定にしている時は、入力まで済んだ場面で止める。
 * 場面が切り替わってもページが上下に揺れないよう、各部の高さはどの場面の中身も収まる値に固定する
 */
export function Demo() {
  const reduced = usePrefersReducedMotion();
  const [playingStep, setPlayingStep] = useState(0);
  const [level, setLevel] = useState(8);

  const stepIndex = reduced ? DEMO_STILL_STEP : playingStep;
  const s = DEMO_SCRIPT[stepIndex];
  const speaking = !!s.speak;

  useEffect(() => {
    if (reduced) return;
    const t = setTimeout(
      () => setPlayingStep((i) => (i + 1) % DEMO_SCRIPT.length),
      DEMO_SCRIPT[playingStep].ms,
    );
    return () => clearTimeout(t);
  }, [playingStep, reduced]);

  // 音量のメーター。話している場面だけ大きく振れる
  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => {
      setLevel(speaking ? 58 + Math.round(Math.random() * 38) : 4 + Math.round(Math.random() * 14));
    }, 140);
    return () => clearInterval(t);
  }, [speaking, reduced]);

  const shownLevel = reduced ? 8 : level;
  const inputFocused = speaking || s.status === "入力しました";

  return (
    <div
      role="img"
      aria-label="mukuchi の動作の例。AI チャットの入力欄に、話した内容が入力され、「送信」と話すと送信されます。"
      data-testid="demo"
      className="@container flex flex-col items-center gap-3 rounded-xl border border-line-subtle bg-gray-50 p-4 lg:gap-4 lg:p-7"
    >
      {/* 入力先のアプリ (AI チャット) */}
      <div className="w-full overflow-hidden rounded-lg border border-line bg-white shadow-md lg:rounded-[10px]">
        <div className="flex h-7 items-center gap-[5px] border-b border-line-subtle px-2.5 lg:h-8 lg:gap-1.5 lg:px-3">
          <span className="size-2 rounded-full bg-gray-200 lg:size-2.5" />
          <span className="size-2 rounded-full bg-gray-200 lg:size-2.5" />
          <span className="size-2 rounded-full bg-gray-200 lg:size-2.5" />
          <span className="mr-[34px] flex-1 text-center text-[11px] text-muted lg:mr-[42px] lg:text-xs">
            AI チャット
          </span>
        </div>
        <div
          data-testid="demo-sent"
          className="flex h-[132px] flex-col justify-end gap-2 overflow-hidden p-3 lg:h-[150px] lg:px-[18px] lg:py-4"
        >
          {s.sent.map((m) => (
            <div
              key={m}
              className="max-w-[88%] self-end rounded-lg bg-blue-50 px-2.5 py-2 text-xs leading-[1.6] text-strong lg:max-w-[80%] lg:rounded-[10px] lg:px-3 lg:text-[13px]"
            >
              {m}
            </div>
          ))}
        </div>
        <div
          data-testid="demo-input"
          className={`mx-3 mb-3 flex h-[60px] items-start gap-0.5 overflow-hidden rounded-md border px-2.5 py-2 text-xs leading-[1.6] text-strong max-[389px]:h-[76px] lg:mx-[18px] lg:mb-[18px] lg:h-16 lg:rounded-lg lg:px-3 lg:py-2.5 lg:text-[13px] ${inputFocused ? "border-focus" : "border-line"}`}
        >
          <span>{s.input}</span>
          <span className="h-[18px] w-[1.5px] flex-none bg-blue-500 lg:h-[19px]" />
        </div>
      </div>

      {/* mukuchi の常時表示パネル。話している間はプレビューの行が上に伸びるので、その分の高さを先に取っておく */}
      <div className="flex h-[62px] w-full flex-none flex-col items-center justify-end lg:h-[66px]">
        <div
          className={`flex max-w-full flex-col overflow-hidden rounded-[18px] border border-line bg-white shadow-md transition-[width] duration-[180ms] ease-standard ${speaking ? "w-full lg:w-[440px]" : "w-[240px] lg:w-[260px]"}`}
        >
          {speaking && (
            <div className="truncate px-3.5 pt-2 text-xs text-body lg:px-4 lg:pt-2.5 lg:text-[13px] lg:leading-[18px]">
              {s.preview}
            </div>
          )}
          <div className="flex h-9 items-center gap-2.5 pr-3 pl-1">
            <div className="flex size-7 flex-none items-center justify-center rounded-full bg-blue-500 text-white">
              <Icon name="mic" size={14} />
            </div>
            <div className="relative flex h-1.5 flex-1 overflow-hidden rounded-[3px]">
              <span className="w-[55%] bg-gray-100" />
              <span className="flex-1 bg-blue-50" />
              <div
                className={`absolute inset-y-0 left-0 rounded-[3px] ${speaking ? "bg-blue-500" : "bg-gray-400"}`}
                style={{ width: `${shownLevel}%` }}
              />
            </div>
            <span className="text-xs font-medium whitespace-nowrap text-muted">{s.status}</span>
          </div>
        </div>
      </div>

      {/* 説明。キー操作の表示と説明が 1 行に収まる幅の時だけ横に並べる */}
      <div
        data-testid="demo-caption"
        className="flex h-11 flex-none flex-col items-center justify-center gap-1.5 text-center text-xs whitespace-nowrap text-muted lg:text-[13px] lg:@min-[420px]:h-6 lg:@min-[420px]:flex-row lg:@min-[420px]:gap-2"
      >
        {s.chip && (
          <span className="flex items-center gap-1.5 rounded-sm bg-gray-900 px-2 py-0.5 text-xs text-white">
            <Icon name="keyboard" size={14} />
            {s.chip}
          </span>
        )}
        <span>{s.caption}</span>
      </div>
    </div>
  );
}
