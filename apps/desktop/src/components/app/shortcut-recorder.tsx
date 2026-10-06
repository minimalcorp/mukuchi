import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CircleAlert, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useShortcutStatus } from "@/lib/hooks";
import { commands } from "@/lib/ipc";
import { eventModifiers, modifierSymbols, recordKey, shortcutParts } from "@/lib/shortcut";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/context";

/** キーの表示 (⌥・Space 等を1つずつ囲む) */
export function ShortcutKeys({ shortcut, className }: { shortcut: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {shortcutParts(shortcut).map((p, i) => (
        <Kbd key={i}>{p}</Kbd>
      ))}
    </span>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-line-strong bg-surface-card px-1.5 font-sans text-xs leading-none text-fg-strong">
      {children}
    </kbd>
  );
}

/**
 * グローバルショートカットの表示と記録。
 * 記録中は Rust の登録を一時解除する (押したキーで音声入力が ON/OFF しないため)。
 * 一時解除は記録の終了・取り消し・フォーカスを失った時・アンマウント時に必ず戻す。
 */
export function ShortcutRecorder({
  shortcut,
  onChange,
  error,
  hint,
  disabled = false,
}: {
  shortcut: string | null | undefined;
  /** update_settings({ shortcut }) を呼ぶ。失敗は error で受け取る */
  onChange: (shortcut: string | null) => void;
  /** 保存の失敗 (登録できなかった)。useSettings の errors.shortcut */
  error?: string;
  /** 記録中でない時に下に出す補足 */
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const status = useShortcutStatus();
  const [recording, setRecording] = useState(false);
  // 記録中に押している修飾キー (「⌥ …」のように途中経過を見せる)
  const [held, setHeld] = useState<string[]>([]);
  // 受け付けないキーを押した時の案内 (記録は続ける)。no_modifier: 修飾キーなし、unsupported: 使えないキー
  const [rejected, setRejected] = useState<"no_modifier" | "unsupported" | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Rust に一時解除を頼んでいるか。戻す (false) を二重に送らないため
  const suspended = useRef(false);

  const resume = useCallback(() => {
    if (!suspended.current) return Promise.resolve();
    suspended.current = false;
    return commands.setShortcutSuspended(false).catch((e: unknown) => console.warn(e));
  }, []);

  // value: undefined は取り消し (保存しない)
  const finish = useCallback(
    (value?: string | null) => {
      setRecording(false);
      setHeld([]);
      setRejected(null);
      // 登録を戻してから保存する。一時解除中の update_settings では登録を試さない実装もありうるため、
      // 通常の状態で登録し直させ、失敗を update_settings のエラーとして受け取る
      void resume().then(() => {
        if (value !== undefined && value !== shortcut) onChange(value);
      });
    },
    [resume, onChange, shortcut],
  );

  const start = () => {
    suspended.current = true;
    commands.setShortcutSuspended(true).catch((e: unknown) => console.warn(e));
    setRecording(true);
    setHeld([]);
    setRejected(null);
    // 記録中のキーはこの枠で受ける。押したボタンにフォーカスが残ると Space・Enter でボタンが押されてしまうため
    boxRef.current?.focus();
  };

  // ウィンドウを閉じた (隠した) 時は取り消す。閉じた後に一時解除が残るとショートカットが効かなくなるため
  useEffect(() => {
    if (!recording) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") finish();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [recording, finish]);

  // カテゴリ・ステップの切り替えで消える時も戻す
  useEffect(
    () => () => {
      void resume();
    },
    [resume],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!recording) return;
    // 記録中のキーはアプリの操作 (ボタン・スクロール等) に使わない
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat) return;
    const r = recordKey(e.nativeEvent);
    if (r.kind === "modifier") {
      setHeld(modifierSymbols(eventModifiers(e.nativeEvent)));
      return;
    }
    if (r.kind === "no_modifier") {
      if (r.code === "Escape") finish();
      else if (r.code === "Backspace" || r.code === "Delete") finish(null);
      else setRejected("no_modifier");
      return;
    }
    if (r.kind === "unsupported") {
      setRejected("unsupported");
      return;
    }
    finish(r.shortcut);
  };

  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!recording) return;
    e.preventDefault();
    setHeld(modifierSymbols(eventModifiers(e.nativeEvent)));
  };

  const warning = !recording && !error ? status?.error : null;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <div
          ref={boxRef}
          tabIndex={-1}
          role="textbox"
          aria-readonly
          aria-label={t.shortcut.label}
          data-testid="shortcut-field"
          data-recording={recording}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={() => {
            if (recording) finish();
          }}
          className={cn(
            "flex h-[30px] min-w-[132px] items-center gap-1 rounded-md border bg-surface-card px-2 text-sm outline-none transition-control",
            recording ? "border-line-focus shadow-[var(--focus-ring)]" : "border-line-default",
          )}
        >
          {recording ? (
            <>
              {held.map((m) => (
                <Kbd key={m}>{m}</Kbd>
              ))}
              <span className="text-xs text-fg-muted">{held.length > 0 ? "…" : t.shortcut.pressKeys}</span>
            </>
          ) : shortcut ? (
            <ShortcutKeys shortcut={shortcut} />
          ) : (
            <span className="text-xs text-fg-muted">{t.shortcut.none}</span>
          )}
        </div>
        {recording ? (
          // 押した時に枠からフォーカスを移さない (blur での取り消しで先にボタンが入れ替わり、クリックが届かなくなるため)
          <Button size="sm" variant="ghost" onMouseDown={(e) => e.preventDefault()} onClick={() => finish()}>
            {t.common.cancel}
          </Button>
        ) : (
          <>
            <Button size="sm" disabled={disabled} onClick={start}>
              {t.shortcut.change}
            </Button>
            {shortcut ? (
              <IconButton icon={X} size="sm" label={t.shortcut.clear} disabled={disabled} onClick={() => onChange(null)} />
            ) : null}
          </>
        )}
      </div>
      {recording ? (
        <p className={cn("m-0 text-xs leading-[1.5]", rejected ? "text-fg-warning" : "text-fg-muted")}>
          {rejected === "unsupported" ? t.shortcut.unsupportedGuide : t.shortcut.recordingGuide}
        </p>
      ) : hint && !error && !warning ? (
        // エラー・警告の間は補足を出さない (セットアップの狭いウィンドウに収めるため。直すべきことを優先して見せる)
        <p className="m-0 text-xs leading-[1.5] text-fg-muted">{hint}</p>
      ) : null}
      {!recording && error ? (
        <p role="alert" className="m-0 flex items-start gap-1.5 text-xs leading-[1.5] text-fg-danger">
          <CircleAlert size={14} className="mt-px flex-none" aria-hidden />
          <span>{error}</span>
        </p>
      ) : null}
      {warning ? (
        <p role="status" className="m-0 flex items-start gap-1.5 text-xs leading-[1.5] text-fg-warning">
          <TriangleAlert size={14} className="mt-px flex-none" aria-hidden />
          <span>{warning}</span>
        </p>
      ) : null}
    </div>
  );
}
