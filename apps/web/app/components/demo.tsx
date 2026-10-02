import { useEffect, useState, useSyncExternalStore } from "react";
import {
  DEMO_MODE_META,
  DEMO_SCRIPTS,
  DEMO_STILL_STEP,
  INPUT_MODES,
  MODE_NAMES,
  type InputMode,
} from "@/lib/content";
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

const isInputMode = (v: string | null): v is InputMode =>
  (INPUT_MODES as readonly (string | null)[]).includes(v);

const noSubscribe = () => () => {};

/**
 * 開発時だけ ?heroMode=always|once でデモのモードを固定できる (デザインの Tweaks の heroMode の代わり。
 * 本番のビルドでは常に null)。URL はページ内で変わらないので購読しない
 */
function useDevHeroMode(): InputMode | null {
  return useSyncExternalStore(
    noSubscribe,
    () => {
      if (!import.meta.env.DEV) return null;
      const m = new URLSearchParams(window.location.search).get("heroMode");
      return isInputMode(m) ? m : null;
    },
    () => null,
  );
}

const otherMode = (m: InputMode): InputMode => (m === "always" ? "once" : "always");

interface Playback {
  mode: InputMode;
  step: number;
  /** タブを押したら、そのモードを繰り返す (交互に替えない) */
  locked: boolean;
}

/**
 * ヒーローのデモ。モードごとの流れ (常に聞き取る: 発話→入力→音声コマンド / 1回ずつ聞き取る: オフ→ショートカット→
 * 1 回分の入力→自動でオフ) を、最後まで進むたびに交互に再生する。
 * 利用者が動きを減らす設定にしている時は、入力まで済んだ場面で止める (タブでモードは替えられる)。
 * 場面やモードが切り替わってもページが上下に揺れないよう、各部の高さはどの場面の中身も収まる値に固定する
 */
export function Demo() {
  const reduced = usePrefersReducedMotion();
  const forced = useDevHeroMode();
  const [play, setPlay] = useState<Playback>({ mode: "always", step: 0, locked: false });
  const [level, setLevel] = useState(8);

  const mode = play.locked ? play.mode : (forced ?? play.mode);
  const script = DEMO_SCRIPTS[mode];
  const stepIndex = reduced ? DEMO_STILL_STEP[mode] : Math.min(play.step, script.length - 1);
  const s = script[stepIndex];
  const meta = DEMO_MODE_META[mode];
  const speaking = !!s.speak;
  const meterKind = speaking ? "speak" : s.noise ? "noise" : "idle";
  const micOn = !!s.on || speaking;

  useEffect(() => {
    if (reduced) return;
    const t = setTimeout(() => {
      setPlay((p) => {
        if (p.step + 1 < DEMO_SCRIPTS[mode].length) return { ...p, mode, step: p.step + 1 };
        // 最後まで進んだら、タブで選んでいない (開発時の固定もない) 時だけもう一方のモードに替える
        const alternate = !p.locked && forced === null;
        return { ...p, mode: alternate ? otherMode(mode) : mode, step: 0 };
      });
    }, s.ms);
    return () => clearTimeout(t);
  }, [play, mode, forced, reduced, s.ms]);

  // 音量のメーター。話している場面は大きく、オフの間の周りの音は中くらいに振れる
  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => {
      const r = Math.random();
      setLevel(
        meterKind === "speak"
          ? 58 + Math.round(r * 38)
          : meterKind === "noise"
            ? 20 + Math.round(r * 40)
            : 4 + Math.round(r * 14),
      );
    }, 140);
    return () => clearInterval(t);
  }, [meterKind, reduced]);

  const shownLevel = reduced ? 8 : level;
  const inputFocused = speaking || s.status === "入力しました";

  return (
    <div
      data-testid="demo"
      data-mode={mode}
      className="@container flex flex-col items-center gap-3 rounded-xl border border-line-subtle bg-gray-50 px-4 pt-3 pb-4 lg:gap-4 lg:px-7 lg:pt-5 lg:pb-6"
    >
      {/* モードの切り替え。スマホは幅いっぱいの 2 等分、PC は左寄せで右に補足を出す */}
      <div className="flex w-full items-center justify-between gap-3">
        <div
          role="group"
          aria-label="デモの聞き取り方"
          className="grid w-full grid-cols-2 gap-0.5 rounded-md border border-line-subtle bg-gray-100 p-0.5 lg:flex lg:w-auto"
        >
          {INPUT_MODES.map((m) => {
            const selected = m === mode;
            return (
              <button
                key={m}
                type="button"
                aria-pressed={selected}
                onClick={() => setPlay({ mode: m, step: 0, locked: true })}
                className={`h-8 cursor-pointer rounded-sm border-0 text-[13px] font-medium lg:h-7 lg:px-3 ${selected ? "bg-white text-strong shadow-xs" : "bg-transparent text-muted"}`}
              >
                {MODE_NAMES[m]}
              </button>
            );
          })}
        </div>
        {/* 幅の狭い PC の配置 (1024px 付近) ではタブと並ばないので出さない */}
        <span
          data-testid="demo-mode-note"
          className="hidden text-xs whitespace-nowrap text-muted lg:@min-[480px]:inline"
        >
          {meta.note}
        </span>
      </div>

      <div
        role="img"
        aria-label={meta.label}
        className="flex w-full flex-col items-center gap-3 lg:gap-4"
      >
        {/* 入力先のアプリ */}
        <div className="w-full overflow-hidden rounded-lg border border-line bg-white shadow-md lg:rounded-[10px]">
          <div className="flex h-7 items-center gap-[5px] border-b border-line-subtle px-2.5 lg:h-8 lg:gap-1.5 lg:px-3">
            <span className="size-2 rounded-full bg-gray-200 lg:size-2.5" />
            <span className="size-2 rounded-full bg-gray-200 lg:size-2.5" />
            <span className="size-2 rounded-full bg-gray-200 lg:size-2.5" />
            <span
              data-testid="demo-app-name"
              className="mr-[34px] flex-1 text-center text-[11px] text-muted lg:mr-[42px] lg:text-xs"
            >
              {meta.appName}
            </span>
          </div>
          <div
            data-testid="demo-sent"
            className="flex h-[112px] flex-col justify-end gap-2 overflow-hidden p-3 lg:h-[130px] lg:px-[18px] lg:py-4"
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
              <div
                className={`flex size-7 flex-none items-center justify-center rounded-full ${micOn ? "bg-blue-500 text-white" : "bg-gray-200 text-gray-600"}`}
              >
                <Icon name={micOn ? "mic" : "mic-off"} size={14} />
              </div>
              <div className="relative flex h-1.5 flex-1 overflow-hidden rounded-[3px]">
                <span className="w-[55%] bg-gray-100" />
                <span className="flex-1 bg-blue-50" />
                <div
                  className={`absolute inset-y-0 left-0 rounded-[3px] ${speaking ? "bg-blue-500" : "bg-gray-400"}`}
                  style={{ width: `${shownLevel}%` }}
                />
              </div>
              <span
                data-testid="demo-status"
                className="text-xs font-medium whitespace-nowrap text-muted"
              >
                {s.status}
              </span>
            </div>
          </div>
        </div>

        {/* 説明。キー操作の表示と説明が 1 行に収まる幅の時だけ横に並べる。
            幅の狭いスマホ (390px 未満) では説明が 2 行に折り返すので、その分の高さを取っておく */}
        <div
          data-testid="demo-caption"
          className="flex h-11 flex-none flex-col items-center justify-center gap-1.5 text-center text-xs text-muted max-[389px]:h-16 lg:text-[13px] lg:@min-[420px]:h-6 lg:@min-[420px]:flex-row lg:@min-[420px]:gap-2"
        >
          {s.chip && (
            <span className="flex items-center gap-1.5 rounded-sm bg-gray-900 px-2 py-0.5 text-xs whitespace-nowrap text-white">
              <Icon name="keyboard" size={14} />
              {s.chip}
            </span>
          )}
          <span>{s.caption}</span>
        </div>
      </div>
    </div>
  );
}
