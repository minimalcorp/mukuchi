import { useCallback, useEffect, useRef, useState } from "react";
import { Cpu, Download, RotateCw } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { ASR_CONTEXT_MAX, commands, runCommand, type AppStatus } from "@/lib/ipc";
import { useModels } from "@/lib/hooks";
import { useI18n, type Messages } from "@/i18n/context";
import { isLocale, LOCALE_AUTONYMS, LOCALES } from "@/i18n/locales";
import { cn } from "@/lib/utils";
import { Card, FieldError, FieldHeading, TitleWithSub, type SectionProps } from "./common";
import { ModelList } from "./ModelList";

function modelState(status: AppStatus | null, t: Messages): { tone: BadgeTone; label: string; sub: string } {
  const r = t.settings.recognition;
  if (!status) return { tone: "neutral", label: r.checking, sub: "" };
  if (status.phase === "loading") {
    const pct = status.loadingProgress == null ? "" : ` ${Math.round(status.loadingProgress * 100)}%`;
    return { tone: "info", label: `${r.loading}${pct}`, sub: r.loadingSub };
  }
  if (status.error?.code === "asr_stopped") {
    return { tone: "danger", label: r.stopped, sub: r.stoppedSub };
  }
  if (status.error?.code === "runtime_missing") {
    return { tone: "warning", label: r.missing, sub: r.missingSub };
  }
  return { tone: "success", label: r.loaded, sub: r.loadedSub };
}

/** Unicode スカラー値の数 (Rust の chars().count() と同じ数え方。String.length は UTF-16 単位で絵文字等を 2 と数える) */
const scalarLength = (s: string) => [...s].length;

/**
 * 複数行テキストの保存。入力のたびには送らず、入力が止まってしばらくした時・フォーカスが外れた時・消える時に送る。
 * IME の変換中は確定前の文字列を送らない。編集中はローカルの値を表示し、保存の往復でカーソルが飛ばないようにする
 */
function useTextCommit(value: string, commit: (v: string) => void, delayMs = 800) {
  const [draft, setDraft] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<string | null>(null);
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const v = latest.current;
    if (v == null) return;
    latest.current = null;
    commitRef.current(v);
  }, []);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, delayMs);
  }, [flush, delayMs]);

  const change = useCallback(
    (v: string, composing: boolean) => {
      setDraft(v);
      if (composing) {
        // 変換中の値は保存の対象にしない (latest は確定済みの値のまま)。待っている保存も止め、確定時に compositionEnd から送り直す
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
      } else {
        latest.current = v;
        schedule();
      }
    },
    [schedule],
  );

  /** 変換の確定時。確定後の input が来るかはブラウザで異なるため、確定した値をここで保存の対象にする */
  const compositionEnd = useCallback(
    (v: string) => {
      latest.current = v;
      schedule();
    },
    [schedule],
  );

  /** フォーカスが外れた時。keepDraft なら (保存できない値) 表示をローカルの値のまま残し、入力を失わない */
  const end = useCallback(
    (keepDraft: boolean) => {
      flush();
      if (!keepDraft) setDraft(null);
    },
    [flush],
  );

  // カテゴリの切り替え等で消える時も、入力した値は保存する
  useEffect(() => flush, [flush]);

  // 設定ウィンドウは閉じると破棄され (src-tauri の on_window_event)、React のアンマウント時の後始末が走るとは
  // 限らない。待ち時間内に ⌘W 等で閉じても最後の入力を失わないよう、ページが隠れる・破棄される時にも送る。
  // ただし破棄の途中で IPC が Rust に届くかは WKWebView で確認できておらず、ベストエフォート
  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [flush]);

  return { value: draft ?? value, change, compositionEnd, end };
}

function AsrContextField({ settings, update, errors }: SectionProps) {
  const { t } = useI18n();
  const r = t.settings.recognition;
  const text = useTextCommit(settings.asrContext, (v) => update({ asrContext: v }));
  // Rust は前後の空白を除いてから上限を確かめるため、同じ数え方にする (末尾の改行だけで超過と表示しない)
  const length = scalarLength(text.value.trim());
  const over = length > ASR_CONTEXT_MAX;
  return (
    <div className="flex flex-col gap-2">
      <FieldHeading
        label={r.context}
        help={r.contextHelp}
        value={
          <span className={cn(over && "font-medium text-fg-danger")}>
            {length} / {ASR_CONTEXT_MAX}
          </span>
        }
      />
      <Textarea
        aria-label={r.context}
        aria-invalid={over || errors.asrContext != null}
        rows={6}
        placeholder={r.contextPlaceholder}
        value={text.value}
        onChange={(e) => text.change(e.target.value, (e.nativeEvent as InputEvent).isComposing)}
        onCompositionEnd={(e) => text.compositionEnd(e.currentTarget.value)}
        onBlur={() => text.end(over)}
      />
      <FieldError
        message={
          errors.asrContext ?? (over ? r.contextOver(ASR_CONTEXT_MAX, length - ASR_CONTEXT_MAX) : null)
        }
      />
    </div>
  );
}

export function RecognitionSection({
  settings,
  update,
  errors,
  status,
}: SectionProps & { status: AppStatus | null }) {
  const { t } = useI18n();
  const r = t.settings.recognition;
  const model = modelState(status, t);
  const { models, error: modelsError } = useModels();
  // 使用中のモデルの名前 (表示言語。Rust の ModelInfo.name)。一覧の取得前は空にする
  const selectedName = models?.find((m) => m.selected)?.name ?? "";

  return (
    <>
      <Card className="flex-row items-center gap-3 p-3.5">
        <Cpu size={20} className="flex-none text-fg-muted" aria-hidden />
        <TitleWithSub title={selectedName || "\u00a0"} sub={model.sub} />
        {status?.error?.code === "runtime_missing" ? (
          <Button size="sm" iconLeft={Download} onClick={() => runCommand(commands.openSetup())}>
            {t.common.openSetup}
          </Button>
        ) : null}
        {status?.error?.code === "asr_stopped" ? (
          <Button size="sm" iconLeft={RotateCw} onClick={() => runCommand(commands.restartAsr())}>
            {t.common.restart}
          </Button>
        ) : null}
        <Badge tone={model.tone} dot>
          {model.label}
        </Badge>
      </Card>
      <div className="flex flex-col gap-2">
        <FieldHeading label={r.speechLanguage} help={r.speechLanguageHelp} />
        <Select
          aria-label={r.speechLanguage}
          data-testid="speech-language"
          className="w-[200px]"
          options={LOCALES.map((l) => ({ value: l, label: LOCALE_AUTONYMS[l] }))}
          value={settings.speechLanguage}
          onValueChange={(v) => {
            if (isLocale(v)) update({ speechLanguage: v });
          }}
        />
        <FieldError message={errors.speechLanguage} />
      </div>
      <ModelList models={models} listError={modelsError} speechLanguage={settings.speechLanguage} />
      <AsrContextField settings={settings} update={update} errors={errors} />
    </>
  );
}
