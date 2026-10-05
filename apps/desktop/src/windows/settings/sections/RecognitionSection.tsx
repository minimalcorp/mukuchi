import { useCallback, useEffect, useRef, useState } from "react";
import { Cpu, Download, RotateCw } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ASR_CONTEXT_MAX, commands, runCommand, type AppStatus } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { Card, FieldError, FieldHeading, TitleWithSub, type SectionProps } from "./common";
import { ModelList } from "./ModelList";

function modelState(status: AppStatus | null): { tone: BadgeTone; label: string; sub: string } {
  if (!status) return { tone: "neutral", label: "確認中", sub: "" };
  if (status.phase === "loading") {
    const pct = status.loadingProgress == null ? "" : ` ${Math.round(status.loadingProgress * 100)}%`;
    return { tone: "info", label: `読み込み中${pct}`, sub: "モデルを読み込んでいます" };
  }
  if (status.error?.code === "asr_stopped") {
    return { tone: "danger", label: "停止中", sub: "文字起こしサーバーが停止しています" };
  }
  if (status.error?.code === "runtime_missing") {
    return { tone: "warning", label: "未導入", sub: "実行環境とモデルがありません" };
  }
  return { tone: "success", label: "読み込み済み", sub: "Apple Silicon GPU で実行中" };
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
  const text = useTextCommit(settings.asrContext, (v) => update({ asrContext: v }));
  // Rust は前後の空白を除いてから上限を確かめるため、同じ数え方にする (末尾の改行だけで超過と表示しない)
  const length = scalarLength(text.value.trim());
  const over = length > ASR_CONTEXT_MAX;
  return (
    <div className="flex flex-col gap-2">
      <FieldHeading
        label="認識のヒント"
        help="書いた内容は文字起こしのモデルにそのまま渡されます。話す話題や、用語の表記（読み方を添えて）を書くと、その表記で認識されやすくなります。長いほど認識が遅くなります"
        value={
          <span className={cn(over && "font-medium text-fg-danger")}>
            {length} / {ASR_CONTEXT_MAX}
          </span>
        }
      />
      <Textarea
        aria-label="認識のヒント"
        aria-invalid={over || errors.asrContext != null}
        rows={6}
        placeholder={"例: 開発の話です。以下の用語は英字で表記する: Claude Code (読み: クロードコード), pnpm"}
        value={text.value}
        onChange={(e) => text.change(e.target.value, (e.nativeEvent as InputEvent).isComposing)}
        onCompositionEnd={(e) => text.compositionEnd(e.currentTarget.value)}
        onBlur={() => text.end(over)}
      />
      <FieldError
        message={
          errors.asrContext ?? (over ? `${ASR_CONTEXT_MAX} 文字を超えています（${length - ASR_CONTEXT_MAX} 文字オーバー）` : null)
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
  const model = modelState(status);

  return (
    <>
      <Card className="flex-row items-center gap-3 p-3.5">
        <Cpu size={20} className="flex-none text-fg-muted" aria-hidden />
        <TitleWithSub title="Qwen3-ASR（日本語追加学習）" sub={model.sub} />
        {status?.error?.code === "runtime_missing" ? (
          <Button size="sm" iconLeft={Download} onClick={() => runCommand(commands.openSetup())}>
            セットアップを開く
          </Button>
        ) : null}
        {status?.error?.code === "asr_stopped" ? (
          <Button size="sm" iconLeft={RotateCw} onClick={() => runCommand(commands.restartAsr())}>
            再起動
          </Button>
        ) : null}
        <Badge tone={model.tone} dot>
          {model.label}
        </Badge>
      </Card>
      <ModelList />
      <AsrContextField settings={settings} update={update} errors={errors} />
    </>
  );
}
