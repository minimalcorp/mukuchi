/*
 * 常時表示パネル (デザイン 03 / 06)。
 * ウィンドウは透明・枠なしで、パネル本体はウィンドウの下中央に置く (Rust がウィンドウを Dock の上に配置する)。
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
import type { ReactNode } from "react";
import { commands, type AppError, type AppStatus } from "@/lib/ipc";
import { useAudioLevel } from "@/lib/audio-level";
import { env } from "@/lib/env";
import { cn } from "@/lib/utils";
import { usePanelModel, type PanelItem } from "./usePanelModel";

const ON_PHASES: AppStatus["phase"][] = ["listening", "speaking", "finalizing", "done"];

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
    // 透明な余白 (影の分) はドラッグ領域にしない。パネル本体だけをドラッグで動かせるようにする
    <div
      className={cn(
        "flex h-full w-full items-end justify-center px-10 pb-8",
        // ブラウザでのモック表示時はデザインのキャンバスと同じ背景にする
        env.browserFrame && "bg-surface-app",
      )}
    >
      {body}
    </div>
  );
}

/* ---------- OFF ---------- */

function OffPill() {
  return (
    <div
      data-tauri-drag-region
      className="flex h-9 items-center rounded-full border border-line-default bg-surface-card px-1 shadow-md"
    >
      <button
        type="button"
        onClick={() => void commands.setListening(true)}
        className="press flex h-7 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent pr-3 pl-2.5 text-xs font-medium text-fg-strong transition-control hover:bg-surface-active"
      >
        <MicOff size={16} className="text-fg-muted" aria-hidden />
        音声入力をオン
      </button>
    </div>
  );
}

/* ---------- 読み込み中・エラー (06) ---------- */

function StatusPill({ icon: Icon, iconClass, spin, children }: {
  icon: LucideIcon;
  iconClass: string;
  spin?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-tauri-drag-region
      role="status"
      className="flex h-8 items-center gap-2 rounded-full border border-line-default bg-surface-card pr-3.5 pl-2.5 shadow-md"
    >
      <Icon size={16} className={cn("flex-none", iconClass, spin && "animate-spin")} aria-hidden />
      <span className="text-xs font-medium whitespace-nowrap text-fg-strong">{children}</span>
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
};

function ErrorPill({ error }: { error: AppError }) {
  const e = ERROR_PILL[error.code];
  return (
    <StatusPill icon={e.icon} iconClass={e.iconClass}>
      {e.short}
    </StatusPill>
  );
}

/* ---------- ON (待機中のメーター / 発話中の展開表示) ---------- */

function ListeningPanel({ isOn, expanded, items }: { isOn: boolean; expanded: boolean; items: PanelItem[] }) {
  return (
    <div
      data-tauri-drag-region
      data-expanded={expanded}
      className={cn(
        "flex flex-col border border-line-default bg-surface-card",
        // ピル (240px) → 展開 (440px) は 180ms・標準イージング。文字の追加はアニメーションさせない
        "transition-[width,border-radius,box-shadow] duration-[180ms] ease-standard",
        expanded ? "w-[440px] rounded-[14px] shadow-lg" : "w-[240px] rounded-[18px] shadow-md",
      )}
    >
      <div
        className="grid transition-[grid-template-rows] duration-[180ms] ease-standard"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="min-h-0 overflow-hidden">
          <Preview items={items} />
        </div>
      </div>
      <div
        className={cn(
          "flex items-center gap-2.5 pr-3 pl-1 transition-[height] duration-[180ms] ease-standard",
          expanded ? "h-9" : "h-[34px]",
        )}
      >
        <ToggleButton isOn={isOn} />
        <LevelMeter active={isOn} />
        <StatusLabel expanded={expanded} items={items} />
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
        onClick={() => void commands.setListening(true)}
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
      onClick={() => void commands.setListening(false)}
      className="press flex size-7 flex-none cursor-pointer items-center justify-center rounded-full border-0 bg-action-primary text-gray-0 transition-control hover:bg-action-primary-hover active:bg-action-primary-active"
    >
      <Mic size={14} aria-hidden />
    </button>
  );
}

/** 入力レベル。20Hz で更新されるのでここだけが購読・再描画する */
function LevelMeter({ active }: { active: boolean }) {
  const { level, threshold } = useAudioLevel();
  const shown = active ? level : 0;
  const over = active && level >= threshold;
  return (
    <div data-tauri-drag-region className="relative h-1.5 flex-1 rounded-[3px] bg-meter-track" data-testid="level-meter">
      <div
        className={cn("h-1.5 rounded-[3px]", over ? "bg-meter-active" : "bg-meter-idle")}
        style={{ width: `${Math.min(1, Math.max(0, shown)) * 100}%` }}
      />
      {/* 発話検出のしきい値 (設定の感度)。超えるとバーが青になる */}
      <span
        className="absolute -top-[3px] h-3 w-0.5 rounded-[1px] bg-meter-threshold"
        style={{ left: `${threshold * 100}%` }}
        aria-hidden
      />
    </div>
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
function Preview({ items }: { items: PanelItem[] }) {
  return (
    <div data-tauri-drag-region className="border-b border-line-subtle px-3.5 pt-2.5 pb-2">
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
