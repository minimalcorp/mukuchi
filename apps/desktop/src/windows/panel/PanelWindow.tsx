/*
 * 常時表示パネル (デザイン 03 / 06)。
 * ウィンドウは透明・枠なしで、描画内容 (ピル・カード + 影の余白) の大きさを set_panel_size で Rust に伝える。
 * Rust はウィンドウをその大きさにし、アンカー (panel-anchor) の辺・角を固定して広げる/縮める (透明部分がクリックを奪わないように)。
 * 描画内容もアンカーに寄せて配置し、展開・収縮がアンカーの辺・角から始まるようにする。
 * 表示形式 (Settings.panelStyle) が compact の時はマイクの円形ボタンだけを出す。
 * 描画内容の種類 (OFF・待機中/認識中・読み込み中・エラー・コンパクト) が変わる時は、面の大きさをアニメーションさせる (useBodyMorph)。
 */
import {
  AudioLines,
  CircleAlert,
  CircleCheck,
  CornerDownLeft,
  Gpu,
  LoaderCircle,
  Mic,
  MicOff,
  PackageX,
  ServerOff,
  ShieldAlert,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";
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
import { useI18n } from "@/i18n/context";
import type { Messages } from "@/i18n/context";
import { usePanelModel, type PanelItem } from "./usePanelModel";
import type { DiffKind } from "./preview-diff";

const ON_PHASES: AppStatus["phase"][] = ["listening", "speaking", "finalizing", "done"];

// ピル・カードの大きさ。展開の最終の大きさを先に求めるため、クラスではなくここで持つ
const CARD_WIDTH = { pill: 240, expanded: 360 };
// ボタン行の高さ。デザインは展開時 36px だが、展開の前後でボタン・メーターの位置が動かないよう待機中のピル (枠線込み36px → 内側34px) と揃える
const ROW_HEIGHT = { pill: 34, expanded: 34 };
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

/** 描画内容の種類。種類が変わる時だけ大きさのアニメーション (useBodyMorph) を付ける */
type BodyKind = "compact" | "listening" | "loading" | "error" | "off";

export function PanelWindow() {
  const { status, items, lastShown, errorVisible } = usePanelModel();
  const anchor = usePanelAnchor();
  const [style, setStyle] = useState<PanelStyle | null>(null);
  // WebView 標準のメニュー (再読み込み・要素の詳細を表示等) は出さない。ピル・カード上では独自のメニューを出す
  useEffect(() => {
    const suppress = (e: Event) => e.preventDefault();
    document.addEventListener("contextmenu", suppress);
    return () => document.removeEventListener("contextmenu", suppress);
  }, []);
  // 表示形式は右クリックメニュー・設定画面から変わる (settings-changed)
  useEffect(() => subscribeWithInitial("settings-changed", commands.getSettings, (s) => setStyle(s.panelStyle)), []);

  const isOn = status ? ON_PHASES.includes(status.phase) : false;
  const expanded = items.length > 0;

  let kind: BodyKind | null = null;
  let body: ReactNode = null;
  if (!status || !style) {
    // 状態・設定の取得前は何も描かない
  } else if (style === "compact") {
    kind = "compact";
    body = <CompactPanel status={status} items={items} />;
  } else if (expanded || isOn) {
    kind = "listening";
    body = <ListeningPanel anchor={anchor} isOn={isOn} expanded={expanded} items={expanded ? items : lastShown} />;
  } else if (status.phase === "loading") {
    kind = "loading";
    body = <LoadingPill progress={status.loadingProgress} />;
  } else if (status.phase === "error" && errorVisible && status.error) {
    kind = "error";
    body = <ErrorPill error={status.error} />;
  } else {
    kind = "off";
    body = <OffPill />;
  }

  const { containerRef, bodyRef, morphRef } = useBodyMorph(kind);
  if (!kind) return null;

  return (
    <div
      data-anchor={`${anchor.vertical}-${anchor.horizontal}`}
      data-panel-style={style}
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
        {/* 描画内容と、種類の切り替え中だけ出す面 (morph) をアンカーに揃えて重ねる。切り替え中の表示は useBodyMorph が DOM に直接書く */}
        <div ref={containerRef} className={cn("grid", ALIGN[anchor.vertical], GRID_JUSTIFY[anchor.horizontal])}>
          <div ref={bodyRef} className="[grid-area:1/1]">
            {body}
          </div>
          <div
            ref={morphRef}
            hidden
            data-testid="panel-morph"
            aria-hidden
            className="rounded-[18px] border border-line-default bg-surface-card shadow-md [grid-area:1/1]"
          />
        </div>
      </PanelFrame>
    </div>
  );
}

const MORPH_DURATION = 180;
const MORPH_EASING = "cubic-bezier(0.2, 0, 0, 1)";

/**
 * 描画内容の種類の切り替え (OFF ⇄ 待機中、通常 ⇄ コンパクト、読み込み中・エラー ⇄ 他) のアニメーション。
 * ピル・カードと同じ面 (morph) を切り替え前の大きさから切り替え後の大きさへ 180ms で変え、その間 切り替え後の内容は見えないまま置く。
 * ウィンドウはアニメーションの間 切り替え前と後の大きい方に保ち (コンテナの min-width/height)、終わってから最終の大きさにする
 * (ListeningPanel の展開・収縮と同じ考え方。縮む途中でウィンドウを変えると、描画と反映がずれて面が揺れる)。
 * 描画前に切り替えるため、useLayoutEffect で DOM に直接書く (state にすると切り替え後の内容が 1 フレーム見える)
 */
function useBodyMorph(kind: BodyKind | null) {
  const containerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const morphRef = useRef<HTMLDivElement>(null);
  // 描画内容の最後の大きさ。ListeningPanel は CSS transition で大きさが変わるため、切り替えたコミットの時点で測ると
  // 古い (展開カードのまま OFF になる等)。ResizeObserver はレイアウトの後に届くので、種類が変わったコミットの
  // layout effect の時点では切り替え前の大きさが残っている
  const lastSizeRef = useRef<Size | null>(null);
  // アニメーション中に再び切り替わった時の開始の大きさ (やり直す直前の面の大きさ)
  const interruptedRef = useRef<Size | null>(null);
  const prevKindRef = useRef<BodyKind | null>(null);
  const shown = kind !== null;

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      lastSizeRef.current = sizeOf(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [shown]);

  // 子 (ListeningPanel) の layout effect が先に最終の大きさ (target) を与えるので、ここで測る body は切り替え後の大きさになる
  useLayoutEffect(() => {
    const prev = prevKindRef.current;
    prevKindRef.current = kind;
    const container = containerRef.current;
    const body = bodyRef.current;
    const morph = morphRef.current;
    const from = interruptedRef.current ?? lastSizeRef.current;
    interruptedRef.current = null;
    // 初回 (まだ何も描いていない) と動きを減らす設定ではアニメーションしない
    // (duration 0 でも finished は非同期に解決し、面だけが 1 フレーム見えうるため、始めない)
    if (!prev || !kind || !container || !body || !morph || !from) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = sizeOf(body);
    container.style.minWidth = `${from.width}px`;
    container.style.minHeight = `${from.height}px`;
    body.style.visibility = "hidden";
    morph.hidden = false;
    const anim = morph.animate(
      [
        { width: `${from.width}px`, height: `${from.height}px` },
        { width: `${to.width}px`, height: `${to.height}px` },
      ],
      { duration: MORPH_DURATION, easing: MORPH_EASING, fill: "forwards" },
    );
    const finish = () => {
      morph.hidden = true;
      body.style.visibility = "";
      container.style.minWidth = "";
      container.style.minHeight = "";
    };
    let done = false;
    // cancel (やり直し・アンマウント) の時は reject される。後始末は cleanup で行う
    anim.finished.then(
      () => {
        done = true;
        finish();
        anim.cancel();
      },
      () => {},
    );
    return () => {
      if (done) return;
      // 次の切り替えはこの面の今の大きさから始める
      interruptedRef.current = sizeOf(morph);
      anim.cancel();
      finish();
    };
  }, [kind]);

  return { containerRef, bodyRef, morphRef };
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
      // 幅は偶数に切り上げる。Rust は中央のアンカーで floor(中心 - 幅/2) に置くため、奇数だと描画内容の中心が
      // 0.5pt ずれ、状態 (ピルの幅) が変わるたびに左右に揺れて見える。フロントエンドはウィンドウ内で中央に置くので端数は吸収される
      const width = Math.ceil(rect.width / 2) * 2;
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
  const { t } = useI18n();
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
        {t.panel.turnOn}
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
  const { t } = useI18n();
  // 進捗が取れない場合は % を出さない (不定表示)
  const pct = progress == null ? "" : ` ${Math.round(progress * 100)}%`;
  return (
    <StatusPill icon={LoaderCircle} iconClass="text-cyan-500" spin>
      {t.panel.loadingModel}
      {pct}
    </StatusPill>
  );
}

// デザイン 06 の短い表示 (文言は辞書の panel.errors)。未定義のコード (microphone_denied / insert_failed) は近いものに合わせた
const ERROR_PILL: Record<AppError["code"], { icon: LucideIcon; iconClass: string }> = {
  accessibility_denied: { icon: ShieldAlert, iconClass: "text-red-500" },
  microphone_denied: { icon: ShieldAlert, iconClass: "text-red-500" },
  asr_stopped: { icon: ServerOff, iconClass: "text-red-500" },
  microphone_missing: { icon: MicOff, iconClass: "text-amber-500" },
  runtime_missing: { icon: PackageX, iconClass: "text-amber-500" },
  insert_failed: { icon: CircleAlert, iconClass: "text-red-500" },
  vad_failed: { icon: CircleAlert, iconClass: "text-red-500" },
  gpu_unavailable: { icon: Gpu, iconClass: "text-red-500" },
};

// Rust が新しいエラーコードを足した場合 (フロントが未対応) は Rust の表示用メッセージをそのまま出す
function errorPill(error: AppError, t: Messages) {
  return Object.hasOwn(ERROR_PILL, error.code)
    ? { ...ERROR_PILL[error.code], short: t.panel.errors[error.code] }
    : { icon: CircleAlert, iconClass: "text-red-500", short: error.message };
}

function ErrorPill({ error }: { error: AppError }) {
  const { t } = useI18n();
  const e = errorPill(error, t);
  return (
    <StatusPill icon={e.icon} iconClass={e.iconClass} action={<ErrorActionButton error={error} />}>
      {e.short}
    </StatusPill>
  );
}

/**
 * 復旧操作 (メニューバー・タスクトレイの復旧項目と同じ)。デザイン 06 のピルは文言のみだが、パネルからも直接復旧できるようにした。
 */
function ErrorActionButton({ error }: { error: AppError }) {
  const { t, platform } = useI18n();
  const action = errorActionView(error.action, t, platform);
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

// 収縮の終わりを知るためのカードの大きさのアニメーション (CSS transition)
const SIZE_TRANSITIONS = new Set(["width", "grid-template-rows"]);

function ListeningPanel({ anchor, isOn, expanded, items }: {
  anchor: PanelAnchor;
  isOn: boolean;
  expanded: boolean;
  items: PanelItem[];
}) {
  const previewRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const drag = usePanelDrag();

  // 収縮のアニメーション中か。展開 → 収縮に変わった描画で true にし (描画中に前回の値と比べる)、
  // カードの大きさのアニメーションが終わったら false にする
  const [collapsing, setCollapsing] = useState(false);
  const [prevExpanded, setPrevExpanded] = useState(expanded);
  if (prevExpanded !== expanded) {
    setPrevExpanded(expanded);
    setCollapsing(!expanded);
  }

  useEffect(() => {
    if (!collapsing) return;
    const running = [cardRef.current, rowsRef.current]
      .flatMap((el) => el?.getAnimations() ?? [])
      .filter((a) => a instanceof CSSTransition && SIZE_TRANSITIONS.has(a.transitionProperty));
    let active = true;
    // 取り消された (再び展開した等) 場合も終わりとして扱う。再び展開した時は cleanup で active が false になっている。
    // 動きを減らす設定 (transition なし) では running が空で、すぐ終わる
    void Promise.allSettled(running.map((a) => a.finished)).then(() => {
      if (active) setCollapsing(false);
    });
    return () => {
      active = false;
    };
  }, [collapsing]);

  // 展開・収縮後の最終の大きさを透明な要素 (target) に与え、カードと同じ位置に重ねる。
  // 親 (PanelFrame) はアニメーション中のカードと target の大きい方になる。
  // 展開時は開始時点で最終の大きさを与え、収縮中は展開時の大きさのまま保って、終わってから最終の大きさにする。
  // これでウィンドウの大きさ (set_panel_size) は展開・収縮それぞれ 1 回だけ変わる。
  // 収縮中にウィンドウを少しずつ縮めると、ネイティブのウィンドウの変更と WebView の描画が同じフレームに揃わず、
  // アンカーの辺 (例: 下端) が上下に揺れて見えるため。
  // 描画前に測るため useLayoutEffect で DOM に直接書く (state にすると 1 フレーム遅れる)
  useLayoutEffect(() => {
    const preview = previewRef.current;
    const target = targetRef.current;
    if (!preview || !target || collapsing) return;
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
        ref={cardRef}
        data-expanded={expanded}
        data-collapsing={collapsing}
        data-testid="panel-card"
        className={cn(
          "flex flex-col select-none border border-line-default bg-surface-card [grid-area:1/1]",
          // ピル (240px) ⇄ 展開 (360px) は展開・収縮とも 180ms・標準イージング (幅と高さで同じ)。文字の追加はアニメーションさせない
          // 角丸は展開しても待機中のピルと同じ 18px に揃える (デザインは展開時 14px だが、形が変わって見えるため利用者の要望で統一)
          "rounded-[18px] transition-[width,box-shadow] duration-[180ms] ease-standard motion-reduce:transition-none",
          expanded ? "shadow-lg" : "shadow-md",
        )}
        style={{ width: expanded ? CARD_WIDTH.expanded : CARD_WIDTH.pill }}
      >
        <div
          ref={rowsRef}
          className="grid transition-[grid-template-rows] duration-[180ms] ease-standard motion-reduce:transition-none"
          style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
        >
          <div
            data-testid="panel-preview-clip"
            className={cn(
              "min-h-0 min-w-0 overflow-hidden transition-opacity ease-standard motion-reduce:transition-none",
              // 収縮時は最終結果の文字を出したまま最初の 80ms で消す (縮むカードに切られていく文字を見せない)。
              // 展開時はすぐ出す (展開の見た目は変えない)
              expanded ? "opacity-100 duration-0" : "opacity-0 duration-(--duration-instant)",
            )}
          >
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
  const { t } = useI18n();
  if (!isOn) {
    return (
      <button
        type="button"
        aria-label={t.panel.turnOn}
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
      aria-label={t.panel.turnOff}
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
  const { t } = useI18n();
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
          <MicOff size={14} aria-label={t.panel.loadingModelShort} />
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

function statusView(items: PanelItem[], t: Messages): StatusView | null {
  if (items.some((it) => it.stage === "speaking")) {
    return { icon: AudioLines, className: "text-fg-listening", label: t.panel.speaking };
  }
  if (items.some((it) => it.stage === "finalizing")) {
    return { icon: LoaderCircle, className: "text-fg-muted", label: t.panel.finalizing, spin: true };
  }
  const last = [...items].reverse().find((it) => it.result);
  const r = last?.result;
  if (!r) return null;
  switch (r.kind) {
    case "inserted":
      // 入力先はフォーカスで分かるためアプリ名は出さず、成功マークだけにする
      return { icon: CircleCheck, className: "text-fg-success", label: t.panel.inserted, iconOnly: true };
    case "command":
      return { icon: CornerDownLeft, className: "text-fg-command", label: t.panel.command };
    case "skipped_excluded":
      // 入力しなかった理由。状態の欄 (約 370px から メーターの最小幅を除いた分) に収まる短さにする
      return { icon: TriangleAlert, className: "text-fg-warning", label: t.panel.excluded(r.appName) };
    case "failed":
      return { icon: CircleAlert, className: "text-fg-danger", label: r.error.message };
  }
}

function StatusLabel({ expanded, items }: { expanded: boolean; items: PanelItem[] }) {
  const { t } = useI18n();
  const view = expanded ? statusView(items, t) : null;
  if (!view) {
    return <span className="text-2xs leading-[1.6] whitespace-nowrap text-fg-muted">{t.panel.idle}</span>;
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

/** プレビュー。前回の表示から挿入・書き換えされた語を一瞬色付けする。3 行を超えたら古い行を上に送る */
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

const DIFF_CLASS: Record<Exclude<DiffKind, "same">, string> = {
  insert: "text-fg-diff-insert animate-preview-diff",
  replace: "text-fg-diff-replace animate-preview-diff",
};

function PreviewItem({ item }: { item: PanelItem }) {
  const { t } = useI18n();
  const r = item.result;
  return (
    <div className="flex flex-none flex-col gap-1">
      <p className="m-0 text-md leading-[1.6] text-pretty text-fg-strong">
        {item.segments.map((seg, i) =>
          seg.kind === "same" ? (
            seg.text
          ) : (
            // revision をキーに含め、次の表示で同じ位置に色付けが続いても作り直してアニメーションを最初からにする
            <span key={`${item.revision}:${i}`} data-diff={seg.kind} className={DIFF_CLASS[seg.kind]}>
              {seg.text}
            </span>
          ),
        )}
      </p>
      {r?.kind === "command" ? (
        <div className="flex items-center gap-1.5 text-xs leading-[1.6] text-fg-muted">
          <CornerDownLeft size={14} aria-hidden />
          <span>
            {t.panel.commandSent(
              <kbd className="rounded-sm border border-line-strong px-1.5 py-px font-mono text-xs text-fg-strong">
                {r.key}
              </kbd>,
            )}
          </span>
        </div>
      ) : null}
    </div>
  );
}
