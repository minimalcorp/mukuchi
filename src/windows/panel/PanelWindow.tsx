/*
 * 常時表示パネル (デザイン 03 / 06)。
 * ウィンドウは透明・枠なしで、描画内容 (ピル・カード + 影の余白) の大きさを set_panel_size で Rust に伝える。
 * Rust はウィンドウをその大きさにし、アンカー (panel-anchor) の辺・角を固定して広げる/縮める (透明部分がクリックを奪わないように)。
 * 描画内容もアンカーに寄せて配置し、展開・収縮がアンカーの辺・角から始まるようにする。
 * 表示形式 (Settings.panelStyle) が compact の時はマイクの円形ボタンだけを出す。
 */
import {
  AudioLines,
  CircleAlert,
  CircleCheck,
  CornerDownLeft,
  LoaderCircle,
  Mic,
  MicOff,
  PackageX,
  ServerOff,
  ShieldAlert,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";
import {
  commands,
  runCommand,
  subscribeWithInitial,
  type AppError,
  type AppStatus,
  type PanelAnchor,
  type PanelStyle,
} from "@/lib/ipc";
import { usePanelAnchor } from "@/lib/hooks";
import { useAudioLevel } from "@/lib/audio-level";
import { LevelMeter } from "@/components/app/level-meter";
import { useLevelEnvelope } from "@/lib/level-envelope";
import { env } from "@/lib/env";
import { errorActionView } from "@/lib/error-actions";
import { usePanelDrag } from "@/lib/panel-drag";
import { cn } from "@/lib/utils";
import { usePanelModel, type PanelItem } from "./usePanelModel";

const ON_PHASES: AppStatus["phase"][] = ["listening", "speaking", "finalizing", "done"];

// ピル・カードの大きさ。展開の最終の大きさを先に求めるため、クラスではなくここで持つ
const CARD_WIDTH = { pill: 240, expanded: 440 };
const ROW_HEIGHT = { pill: 34, expanded: 36 };
const CARD_BORDER = 1;

// アンカーへの寄せ方。ウィンドウ内 (flex) とカード・最終の大きさの要素の重ね方 (grid) で同じ向きにする
// align-items は flex・grid で共通
const ALIGN: Record<PanelAnchor["vertical"], string> = { top: "items-start", bottom: "items-end" };
const FLEX_JUSTIFY: Record<PanelAnchor["horizontal"], string> = {
  left: "justify-start",
  center: "justify-center",
  right: "justify-end",
};
const GRID_JUSTIFY: Record<PanelAnchor["horizontal"], string> = {
  left: "justify-items-start",
  center: "justify-items-center",
  right: "justify-items-end",
};

type Size = { width: number; height: number };

const sizeOf = (el: HTMLElement): Size => {
  const rect = el.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
};

/** 表示形式と、切り替え直後のアニメーションの開始時の大きさ (切り替え前の描画内容の大きさ) */
type StyleView = { style: PanelStyle; morphFrom: Size | null };

export function PanelWindow() {
  const { status, items, lastShown, errorVisible } = usePanelModel();
  const anchor = usePanelAnchor();
  const bodyRef = useRef<HTMLDivElement>(null);
  const morphRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<StyleView | null>(null);
  // WebView 標準のメニュー (再読み込み・要素の詳細を表示等) は出さない。ピル・カード上では独自のメニューを出す
  useEffect(() => {
    const suppress = (e: Event) => e.preventDefault();
    document.addEventListener("contextmenu", suppress);
    return () => document.removeEventListener("contextmenu", suppress);
  }, []);
  // 表示形式は右クリックメニュー・設定画面から変わる (settings-changed)
  useEffect(
    () =>
      subscribeWithInitial("settings-changed", commands.getSettings, (s) => {
        // 切り替えのアニメーション中に再び切り替わった時は、アニメーション中の大きさから始める
        const shown = morphRef.current ?? bodyRef.current;
        const from = shown ? sizeOf(shown) : null;
        setView((prev) => {
          if (prev?.style === s.panelStyle) return prev;
          // 初回 (まだ何も描いていない) はアニメーションしない
          return { style: s.panelStyle, morphFrom: prev ? from : null };
        });
      }),
    [],
  );
  const endMorph = useCallback(() => setView((v) => (v && v.morphFrom ? { ...v, morphFrom: null } : v)), []);
  if (!status || !view) return null;

  const isOn = ON_PHASES.includes(status.phase);
  const expanded = items.length > 0;

  let body: ReactNode;
  if (view.style === "compact") {
    body = <CompactPanel status={status} items={items} />;
  } else if (expanded || isOn) {
    body = <ListeningPanel anchor={anchor} isOn={isOn} expanded={expanded} items={expanded ? items : lastShown} />;
  } else if (status.phase === "loading") {
    body = <LoadingPill progress={status.loadingProgress} />;
  } else if (status.phase === "error" && errorVisible && status.error) {
    body = <ErrorPill error={status.error} />;
  } else {
    body = <OffPill />;
  }

  return (
    <div
      data-anchor={`${anchor.vertical}-${anchor.horizontal}`}
      data-panel-style={view.style}
      className={cn(
        "flex h-full w-full overflow-hidden",
        // 実機ではウィンドウ = PanelFrame の大きさだが、大きさの反映が遅れる間もアンカー側を合わせておく
        ALIGN[anchor.vertical],
        FLEX_JUSTIFY[anchor.horizontal],
        // ブラウザでのモック表示時はデザインのキャンバスと同じ背景にする
        env.browserFrame && "bg-surface-app",
      )}
    >
      <PanelFrame>
        {/* 切り替えのアニメーション中は、切り替え後の内容を見えないまま置いて最終の大きさをウィンドウに伝え、
            その上に大きさだけが変わる面を重ねる (ListeningPanel の展開・収縮と同じ考え方) */}
        <div className={cn("grid", ALIGN[anchor.vertical], GRID_JUSTIFY[anchor.horizontal])}>
          <div ref={bodyRef} className={cn("[grid-area:1/1]", view.morphFrom && "invisible")}>
            {body}
          </div>
          {view.morphFrom ? (
            <StyleMorph ref={morphRef} from={view.morphFrom} targetRef={bodyRef} onDone={endMorph} />
          ) : null}
        </div>
      </PanelFrame>
    </div>
  );
}

/**
 * 表示形式の切り替え (通常 ⇄ コンパクト) のアニメーション。ピル・カードと同じ面の大きさを
 * 切り替え前の大きさから切り替え後の大きさへ 180ms で変え、終わったら onDone で切り替え後の内容を出す。
 * 終わりを知るため CSS transition ではなく Web Animations を使う (大きさが同じでも finished が解決する)
 */
function StyleMorph({ from, targetRef, onDone, ref }: {
  from: Size;
  targetRef: RefObject<HTMLDivElement | null>;
  onDone: () => void;
  ref: RefObject<HTMLDivElement | null>;
}) {
  useLayoutEffect(() => {
    const el = ref.current;
    const target = targetRef.current;
    if (!el || !target) return;
    const to = sizeOf(target);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const anim = el.animate(
      [
        { width: `${from.width}px`, height: `${from.height}px` },
        { width: `${to.width}px`, height: `${to.height}px` },
      ],
      { duration: reduced ? 0 : 180, easing: "cubic-bezier(0.2, 0, 0, 1)", fill: "forwards" },
    );
    // cancel (アンマウント・やり直し) の時は reject されるので何もしない
    anim.finished.then(onDone, () => {});
    return () => anim.cancel();
  }, [from, ref, targetRef, onDone]);
  return (
    <div
      ref={ref}
      data-testid="panel-style-morph"
      aria-hidden
      className="rounded-[18px] border border-line-default bg-surface-card shadow-md [grid-area:1/1]"
      style={{ width: from.width, height: from.height }}
    />
  );
}

/**
 * 描画内容 + 影の余白。この要素の大きさをウィンドウの大きさにする。
 * 余白は shadow-lg (0 8px 24px) が切れない幅で、状態によらず一定にする (ピルの位置が状態で動かないように)。
 * 余白は操作もドラッグもできない (pointer-events: none)。操作できるのはピル・カードだけ。
 */
function PanelFrame({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let last = "";
    const send = () => {
      const rect = el.getBoundingClientRect();
      const width = Math.ceil(rect.width);
      const height = Math.ceil(rect.height);
      const key = `${width}x${height}`;
      if (key === last) return;
      last = key;
      runCommand(commands.setPanelSize(width, height));
    };
    const observer = new ResizeObserver(send);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} data-testid="panel-frame" className="pointer-events-none flex-none px-6 pt-4 pb-8">
      <div className="pointer-events-auto">{children}</div>
    </div>
  );
}

/* ---------- OFF ---------- */

function OffPill() {
  const drag = usePanelDrag();
  return (
    // ドラッグはピル全体 (ボタンの上も含む) で行う。動かさずに離した時だけボタンの操作になる
    <div
      {...drag}
      data-testid="panel-pill"
      className="flex h-9 items-center select-none rounded-full border border-line-default bg-surface-card px-1 shadow-md"
    >
      <button
        type="button"
        onClick={() => runCommand(commands.setListening(true))}
        className="press flex h-7 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent pr-3 pl-2.5 text-xs font-medium text-fg-strong transition-control hover:bg-surface-active"
      >
        <MicOff size={16} className="text-fg-muted" aria-hidden />
        音声入力をオン
      </button>
    </div>
  );
}

/* ---------- 読み込み中・エラー (06) ---------- */

function StatusPill({ icon: Icon, iconClass, spin, action, children }: {
  icon: LucideIcon;
  iconClass: string;
  spin?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  const drag = usePanelDrag();
  return (
    <div
      {...drag}
      data-testid="panel-pill"
      className={cn(
        "flex h-8 items-center select-none gap-2 rounded-full border border-line-default bg-surface-card pl-2.5 shadow-md",
        action ? "pr-1" : "pr-3.5",
      )}
    >
      <span role="status" className="flex items-center gap-2">
        <Icon size={16} className={cn("flex-none", iconClass, spin && "animate-spin")} aria-hidden />
        <span className="text-xs font-medium whitespace-nowrap text-fg-strong">{children}</span>
      </span>
      {action}
    </div>
  );
}

function LoadingPill({ progress }: { progress: number | null }) {
  // 進捗が取れない場合は % を出さない (不定表示)
  const pct = progress == null ? "" : ` ${Math.round(progress * 100)}%`;
  return (
    <StatusPill icon={LoaderCircle} iconClass="text-cyan-500" spin>
      モデルを読み込んでいます…{pct}
    </StatusPill>
  );
}

// デザイン 06 の短い表示。未定義のコード (microphone_denied / insert_failed) は近いものに合わせた
const ERROR_PILL: Record<AppError["code"], { icon: LucideIcon; iconClass: string; short: string }> = {
  accessibility_denied: { icon: ShieldAlert, iconClass: "text-red-500", short: "アクセシビリティが未許可です" },
  microphone_denied: { icon: ShieldAlert, iconClass: "text-red-500", short: "マイクが未許可です" },
  asr_stopped: { icon: ServerOff, iconClass: "text-red-500", short: "文字起こしが停止しました" },
  microphone_missing: { icon: MicOff, iconClass: "text-amber-500", short: "マイクが見つかりません" },
  runtime_missing: { icon: PackageX, iconClass: "text-amber-500", short: "モデルがありません" },
  insert_failed: { icon: CircleAlert, iconClass: "text-red-500", short: "入力できませんでした" },
  vad_failed: { icon: CircleAlert, iconClass: "text-red-500", short: "発話検出を開始できません" },
};

// Rust が新しいエラーコードを足した場合 (フロントが未対応) は Rust の表示用メッセージをそのまま出す
function errorPill(error: AppError) {
  return Object.hasOwn(ERROR_PILL, error.code)
    ? ERROR_PILL[error.code]
    : { icon: CircleAlert, iconClass: "text-red-500", short: error.message };
}

function ErrorPill({ error }: { error: AppError }) {
  const e = errorPill(error);
  return (
    <StatusPill icon={e.icon} iconClass={e.iconClass} action={<ErrorActionButton error={error} />}>
      {e.short}
    </StatusPill>
  );
}

/**
 * 復旧操作 (メニューバーの復旧項目と同じ)。デザイン 06 のピルは文言のみだが、パネルからも直接復旧できるようにした。
 */
function ErrorActionButton({ error }: { error: AppError }) {
  const action = errorActionView(error.action);
  if (!action) return null;
  const Icon = action.icon;
  return (
    <button
      type="button"
      onClick={() => runCommand(action.run())}
      className="press flex h-6 flex-none cursor-pointer items-center gap-1 rounded-full border-0 bg-surface-active px-2.5 text-2xs font-medium whitespace-nowrap text-fg-strong transition-control hover:bg-surface-hover"
    >
      <Icon size={12} aria-hidden />
      {action.label}
    </button>
  );
}

/* ---------- ON (待機中のメーター / 発話中の展開表示) ---------- */

function ListeningPanel({ anchor, isOn, expanded, items }: {
  anchor: PanelAnchor;
  isOn: boolean;
  expanded: boolean;
  items: PanelItem[];
}) {
  const previewRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const drag = usePanelDrag();

  // 展開・収縮後の最終の大きさを透明な要素 (target) に与え、カードと同じ位置に重ねる。
  // 親 (PanelFrame) はアニメーション中のカードと target の大きい方になるので、
  // 展開時は開始時点で最終の大きさがウィンドウに伝わり、収縮時はカードに合わせて縮む (途中でカードが切れない)。
  // 描画前に測るため useLayoutEffect で DOM に直接書く (state にすると 1 フレーム遅れる)
  useLayoutEffect(() => {
    const preview = previewRef.current;
    const target = targetRef.current;
    if (!preview || !target) return;
    const apply = () => {
      const width = expanded ? CARD_WIDTH.expanded : CARD_WIDTH.pill;
      const rowHeight = expanded ? ROW_HEIGHT.expanded : ROW_HEIGHT.pill;
      // プレビューは常に展開時の幅で描いている (収縮中も高さ 0 の枠の中にある) ので、その高さが最終の高さ
      const height = (expanded ? preview.getBoundingClientRect().height : 0) + rowHeight + CARD_BORDER * 2;
      target.style.width = `${width}px`;
      target.style.height = `${height}px`;
    };
    apply();
    // 同梱フォントの読み込みで文字の折り返しが変わった時も合わせる
    document.fonts.addEventListener("loadingdone", apply);
    return () => document.fonts.removeEventListener("loadingdone", apply);
  });

  // カードと target をアンカーの辺・角に揃えて重ねる。幅・高さのアニメーションはアンカーの反対側へ伸び縮みする
  // (top ならカードの上端が動かず、プレビュー → メーター行の順のまま下へ広がる)
  return (
    <div className={cn("grid", ALIGN[anchor.vertical], GRID_JUSTIFY[anchor.horizontal])}>
      <div ref={targetRef} className="invisible [grid-area:1/1]" aria-hidden />
      <div
        {...drag}
        data-expanded={expanded}
        data-testid="panel-card"
        className={cn(
          "flex flex-col select-none border border-line-default bg-surface-card [grid-area:1/1]",
          // ピル (240px) → 展開 (440px) は 180ms・標準イージング。文字の追加はアニメーションさせない
          "transition-[width,border-radius,box-shadow] duration-[180ms] ease-standard",
          expanded ? "rounded-[14px] shadow-lg" : "rounded-[18px] shadow-md",
        )}
        style={{ width: expanded ? CARD_WIDTH.expanded : CARD_WIDTH.pill }}
      >
        <div
          className="grid transition-[grid-template-rows] duration-[180ms] ease-standard"
          style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
        >
          <div className="min-h-0 min-w-0 overflow-hidden">
            {/* 展開時の幅で固定する。アニメーション中に文字が折り返し直されず、最終の高さを先に測れる */}
            <div style={{ width: CARD_WIDTH.expanded - CARD_BORDER * 2 }}>
              <Preview ref={previewRef} items={items} />
            </div>
          </div>
        </div>
        <div
          className="flex items-center gap-2.5 pr-3 pl-1 transition-[height] duration-[180ms] ease-standard"
          style={{ height: expanded ? ROW_HEIGHT.expanded : ROW_HEIGHT.pill }}
        >
          <ToggleButton isOn={isOn} />
          <PanelLevelMeter active={isOn} />
          <StatusLabel expanded={expanded} items={items} />
        </div>
      </div>
    </div>
  );
}

function ToggleButton({ isOn, className }: { isOn: boolean; className?: string }) {
  if (!isOn) {
    return (
      <button
        type="button"
        aria-label="音声入力をオン"
        onClick={() => runCommand(commands.setListening(true))}
        className={cn(
          "press flex size-7 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-surface-active text-fg-muted transition-control",
          className,
        )}
      >
        <MicOff size={14} aria-hidden />
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-label="音声入力をオフ"
      onClick={() => runCommand(commands.setListening(false))}
      className={cn(
        "press flex size-7 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-action-primary text-gray-0 transition-control hover:bg-action-primary-hover active:bg-action-primary-active",
        className,
      )}
    >
      <Mic size={14} aria-hidden />
    </button>
  );
}

/* ---------- コンパクト表示 (マイクの円形ボタンのみ) ---------- */

type CompactState = "off" | "loading" | "listening" | "speaking" | "finalizing" | "error";

function compactState(status: AppStatus, items: PanelItem[]): CompactState {
  switch (status.phase) {
    case "off":
    case "loading":
    case "error":
    case "speaking":
      return status.phase;
    default:
      // 話し終わった発話の確定処理中は、次の発話を待つ間 (listening) も確定中として出す
      return status.phase === "finalizing" || items.some((it) => it.stage === "finalizing") ? "finalizing" : "listening";
  }
}

/**
 * プレビュー・文言は出さず、状態はボタンの周りの表示だけで示す。
 * エラーは右上の赤い点のみ (内容と復旧は右クリックメニューに出る)。ドラッグ・右クリックは通常の表示と同じ
 */
function CompactPanel({ status, items }: { status: AppStatus; items: PanelItem[] }) {
  const drag = usePanelDrag();
  const state = compactState(status, items);
  const isOn = ON_PHASES.includes(status.phase);
  return (
    <div
      {...drag}
      data-testid="panel-compact"
      data-state={state}
      // 36px の円 (枠 1px + 余白 3px + ボタン 28px)。ピルと同じ面・枠・影
      className="relative flex size-9 items-center justify-center select-none rounded-full border border-line-default bg-surface-card shadow-md"
    >
      {isOn ? <CompactLevelRing active={state === "speaking"} /> : null}
      {state === "finalizing" || state === "loading" ? <CompactSpinner muted={state === "loading"} /> : null}
      {state === "loading" ? (
        // 読み込み中は通常の表示と同じく切り替えを出さない
        <span className="relative flex size-7 items-center justify-center rounded-full bg-surface-active text-fg-muted">
          <MicOff size={14} aria-label="モデルを読み込んでいます" />
        </span>
      ) : (
        // リング (absolute) より上に描くため relative にする
        <ToggleButton isOn={isOn} className="relative" />
      )}
      {state === "error" && status.error ? (
        <span
          role="img"
          aria-label={status.error.message}
          data-testid="panel-compact-error"
          className="pointer-events-none absolute -top-px -right-px size-2.5 rounded-full border-2 border-surface-card bg-red-500"
        />
      ) : null}
    </div>
  );
}

// レベル 1 の時のリングの倍率 (28px → 約 52px。影の余白の上 16px に収まる)
const RING_GROWTH = 0.85;
const writeRingScale = (el: HTMLElement, v: number) => {
  el.style.transform = `scale(${1 + v * RING_GROWTH})`;
};

/**
 * 発話中に音量に合わせて広がるリング。ボタンの後ろの薄い円で、ボタンからはみ出した分がリングに見える。
 * 発話中でなければ 0 に戻して (ゆっくり縮めて) ボタンの後ろに隠す。約15Hz で更新されるのでここだけが購読する
 */
function CompactLevelRing({ active }: { active: boolean }) {
  const { level } = useAudioLevel();
  const ref = useLevelEnvelope<HTMLSpanElement>(active ? level : 0, writeRingScale);
  return (
    <span
      ref={ref}
      aria-hidden
      data-testid="panel-compact-ring"
      // 枠の内側 (34px) から 3px 内側 = ボタンと同じ 28px
      className="pointer-events-none absolute inset-[3px] rounded-full bg-meter-ring"
    />
  );
}

/** 確定処理中 (読み込み中) の細い回転するリング。動きを減らす設定では回さず、全周を塗った静止したリングにする */
function CompactSpinner({ muted }: { muted: boolean }) {
  return (
    <span
      aria-hidden
      data-testid="panel-compact-spinner"
      className={cn(
        "pointer-events-none absolute -inset-1 rounded-full border-2 motion-safe:animate-spin",
        muted
          ? "border-meter-track border-t-meter-idle motion-reduce:border-meter-idle"
          : "border-meter-ring border-t-meter-active motion-reduce:border-meter-active",
      )}
    />
  );
}

/** 入力レベル。約15Hz で更新されるのでここだけが購読・再描画する */
function PanelLevelMeter({ active }: { active: boolean }) {
  const { level, threshold } = useAudioLevel();
  return (
    <LevelMeter
      testId="level-meter"
      // 状態の文言 (入力できなかった理由など) が長くてもメーターを潰さない。文言の方を省略する
      className="min-w-16"
      level={active ? level : 0}
      threshold={threshold}
      active={active && level >= threshold}
    />
  );
}

// iconOnly: 文言は読み上げ用にだけ持ち、アイコンだけを表示する
type StatusView = { icon: LucideIcon | null; className: string; label: string; spin?: boolean; iconOnly?: boolean };

function statusView(items: PanelItem[]): StatusView | null {
  if (items.some((it) => it.stage === "speaking")) {
    return { icon: AudioLines, className: "text-fg-listening", label: "認識中" };
  }
  if (items.some((it) => it.stage === "finalizing")) {
    return { icon: LoaderCircle, className: "text-fg-muted", label: "確定しています…", spin: true };
  }
  const last = [...items].reverse().find((it) => it.result);
  const r = last?.result;
  if (!r) return null;
  switch (r.kind) {
    case "inserted":
      // 入力先はフォーカスで分かるためアプリ名は出さず、成功マークだけにする
      return { icon: CircleCheck, className: "text-fg-success", label: "入力しました", iconOnly: true };
    case "command":
      return { icon: CornerDownLeft, className: "text-fg-command", label: "音声コマンド" };
    case "skipped_excluded":
      // 入力しなかった理由。状態の欄 (約 370px から メーターの最小幅を除いた分) に収まる短さにする
      return { icon: TriangleAlert, className: "text-fg-warning", label: `${r.appName} は入力しない設定です` };
    case "failed":
      return { icon: CircleAlert, className: "text-fg-danger", label: r.error.message };
  }
}

function StatusLabel({ expanded, items }: { expanded: boolean; items: PanelItem[] }) {
  const view = expanded ? statusView(items) : null;
  if (!view) {
    return <span className="text-2xs leading-[1.6] whitespace-nowrap text-fg-muted">待機中</span>;
  }
  const Icon = view.icon;
  return (
    <span
      role="status"
      className={cn(
        "flex min-w-0 items-center gap-1 text-2xs leading-[1.6] font-medium whitespace-nowrap",
        view.className,
      )}
    >
      {Icon ? <Icon size={12} className={cn("flex-none", view.spin && "animate-spin")} aria-hidden /> : null}
      <span className={view.iconOnly ? "sr-only" : "truncate"}>{view.label}</span>
    </span>
  );
}

/** プレビュー。確定部分は濃く、未確定の末尾は薄いグレー。3 行を超えたら古い行を上に送る */
function Preview({ items, ref }: { items: PanelItem[]; ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} className="border-b border-line-subtle px-3.5 pt-2.5 pb-2">
      <div
        data-testid="preview"
        // 下揃えで溢れた分を上側で切る = 古い行から上に送られる
        className="flex max-h-[calc(14px*1.6*3)] min-h-[calc(14px*1.6)] flex-col justify-end overflow-hidden"
      >
        {items.map((it) => (
          <PreviewItem key={it.id} item={it} />
        ))}
      </div>
    </div>
  );
}

function PreviewItem({ item }: { item: PanelItem }) {
  const stable = item.text.slice(0, item.stableLength);
  const tail = item.text.slice(item.stableLength);
  const r = item.result;
  return (
    <div className="flex flex-none flex-col gap-1">
      <p className="m-0 text-md leading-[1.6] text-pretty text-fg-strong">
        {stable}
        {tail ? <span className="text-fg-unstable">{tail}</span> : null}
      </p>
      {r?.kind === "command" ? (
        <div className="flex items-center gap-1.5 text-xs leading-[1.6] text-fg-muted">
          <CornerDownLeft size={14} aria-hidden />
          <kbd className="rounded-sm border border-line-strong px-1.5 py-px font-mono text-xs text-fg-strong">{r.key}</kbd>
          を送信しました
        </div>
      ) : null}
    </div>
  );
}
