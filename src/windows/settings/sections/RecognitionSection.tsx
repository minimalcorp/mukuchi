import { useState } from "react";
import { Cpu, Plus, RotateCw, X } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { commands, type AppStatus } from "@/lib/ipc";
import { Card, FieldHeading, TitleWithSub, type SectionProps } from "./common";

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

export function RecognitionSection({ settings, update, status }: SectionProps & { status: AppStatus | null }) {
  const [draft, setDraft] = useState("");
  const vocab = settings.vocabulary;
  const model = modelState(status);

  const add = () => {
    const words = draft
      .split(/[\s、,]+/)
      .map((w) => w.trim())
      .filter((w) => w && !vocab.includes(w));
    if (words.length > 0) update({ vocabulary: [...vocab, ...words] });
    setDraft("");
  };

  return (
    <>
      <Card className="flex-row items-center gap-3 p-3.5">
        <Cpu size={20} className="flex-none text-fg-muted" aria-hidden />
        <TitleWithSub title="Qwen3-ASR（日本語追加学習）" sub={model.sub} />
        {status?.error?.code === "asr_stopped" ? (
          <Button size="sm" iconLeft={RotateCw} onClick={() => void commands.restartAsr()}>
            再起動
          </Button>
        ) : null}
        <Badge tone={model.tone} dot>
          {model.label}
        </Badge>
      </Card>
      <div className="flex flex-col gap-2.5">
        <FieldHeading
          label="語彙ヒント"
          help="固有名詞や専門用語を登録すると、その表記で認識されやすくなります"
          value={`${vocab.length} 語`}
        />
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Input
            aria-label="語彙ヒントに追加する語"
            className="flex-1"
            placeholder="語を入力して Enter"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <Button type="submit" iconLeft={Plus} disabled={draft.trim() === ""}>
            追加
          </Button>
        </form>
        <div className="flex flex-wrap gap-1.5">
          {vocab.map((v) => (
            <span
              key={v}
              className="flex items-center gap-1 rounded-sm border border-line-default py-[3px] pr-1.5 pl-2.5 text-xs"
            >
              {v}
              <button
                type="button"
                aria-label={`${v} を削除`}
                onClick={() => update({ vocabulary: vocab.filter((w) => w !== v) })}
                className="inline-flex cursor-pointer border-0 bg-transparent p-0 text-fg-subtle hover:text-fg-muted"
              >
                <X size={12} aria-hidden />
              </button>
            </span>
          ))}
        </div>
      </div>
    </>
  );
}
