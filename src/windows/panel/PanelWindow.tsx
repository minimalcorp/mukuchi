/*
 * 常時表示パネル (デザイン 03 / 06)。
 * ウィンドウは透明・枠なしで、描画内容 (ピル・カード + 影の余白) の大きさを set_panel_size で Rust に伝える。
 * Rust はウィンドウをその大きさにし、下端中央を基準位置に保つ (透明部分がクリックを奪わないように)。
 */
import {
  AudioLines,
  Ban,
  CircleAlert,
  CircleCheck,
  CornerDownLeft,
  LoaderCircle,
  Mic,
  MicOff,
  PackageX,
  ServerOff,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type ReactNode, type Ref } from "react";
import { commands, runCommand, type AppError, type AppStatus } from "@/lib/ipc";
import { useAudioLevel } from "@/lib/audio-level";
import { LevelMeter } from "@/components/app/level-meter";
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

export function PanelWindow() {
  const { status, items, lastShown, errorVisible } = usePanelModel();
  if (!status) return null;

  const isOn = ON_PHASES.includes(status.phase);
  const expanded = items.length > 0;

  let body: ReactNode;
  if (expanded || isOn) {
    body = <ListeningPanel isOn={isOn} expanded={expanded} items={expanded ? items : lastShown} />;
  } else if (status.phase === "loading") {
    body = <LoadingPill progress={status.loadingProgress} />;
  } else if (status.phase === "error" && errorVisible && status.error) {
    body = <ErrorPill error={status.error} />;
  } else {
    body = <OffPill />;
  }

  return (
    <div
      className={cn(
        "flex h-full w-full items-end justify-center overflow-hidden",
        // ブラウザでのモック表示時はデザインのキャンバスと同じ背景にする
        env.browserFrame && "bg-surface-app",
      )}
    >
      <PanelFrame>{body}</PanelFrame>
    </div>
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

function ListeningPanel({ isOn, expanded, items }: { isOn: boolean; expanded: boolean; items: PanelItem[] }) {
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

  return (
    <div className="grid items-end justify-items-center">
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

function ToggleButton({ isOn }: { isOn: boolean }) {
  if (!isOn) {
    return (
      <button
        type="button"
        aria-label="音声入力をオン"
        onClick={() => runCommand(commands.setListening(true))}
        className="press flex size-7 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-surface-active text-fg-muted transition-control"
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
      className="press flex size-7 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-action-primary text-gray-0 transition-control hover:bg-action-primary-hover active:bg-action-primary-active"
    >
      <Mic size={14} aria-hidden />
    </button>
  );
}

/** 入力レベル。約15Hz で更新されるのでここだけが購読・再描画する */
function PanelLevelMeter({ active }: { active: boolean }) {
  const { level, threshold } = useAudioLevel();
  return (
    <LevelMeter
      testId="level-meter"
      level={active ? level : 0}
      threshold={threshold}
      active={active && level >= threshold}
    />
  );
}

type StatusView = { icon: LucideIcon | null; className: string; label: string; spin?: boolean };

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
      return { icon: CircleCheck, className: "text-fg-success", label: `${r.appName} に入力しました` };
    case "command":
      return { icon: CornerDownLeft, className: "text-fg-command", label: "音声コマンド" };
    case "skipped_excluded":
      return { icon: Ban, className: "text-fg-warning", label: "このアプリには入力しません" };
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
      <span className="truncate">{view.label}</span>
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
