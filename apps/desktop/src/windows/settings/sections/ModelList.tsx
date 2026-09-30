/*
 * モデルの管理 (docs/architecture.md「モデルの管理」)。認識カテゴリの一部。
 * 状態は Rust の ModelInfo[] (list_models + models-changed) をそのまま表示し、
 * この画面が持つのは応答待ちの操作 (切り替え・一時停止等) と command の失敗だけ。
 */
import { useState, type ReactNode } from "react";
import { CircleAlert, Download, Pause, Play, RotateCw, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { formatBytes, formatBytesPair, formatEta } from "@/lib/format";
import { errorMessage, useModels, useProvisioning } from "@/lib/hooks";
import { commands, type ModelInfo } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { Card, ConfirmLayout, FieldError, FieldHeading, Row } from "./common";

type Op = "download" | "pause" | "cancel";

const DOWNLOADING_ELSEWHERE = "他のモデルをダウンロード中です。同時にダウンロードできるのは 1 つです";
const IN_USE = "使用中のモデルは削除できません。他のモデルに切り替えてから削除してください";

export function ModelList() {
  const { models, error: listError } = useModels();
  const provisioning = useProvisioning();
  // モデルの操作はセットアップ完了後のみ (Rust も拒む)。取得前 (null) も操作させない
  const ready = provisioning?.stage === "done";
  // 切り替え中のモデル。select_model は準備完了まで返らないため、その間は切り替え・削除を止める
  const [switching, setSwitching] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ id: string; op: Op } | null>(null);
  // command の失敗 (取得自体の失敗は ModelInfo.error で届く)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState<ModelInfo | null>(null);

  const setRowError = (id: string, message: string | null) =>
    setRowErrors((prev) => {
      const next = { ...prev };
      if (message) next[id] = message;
      else delete next[id];
      return next;
    });

  const run = (id: string, op: Op, action: () => Promise<void>) => {
    setBusy({ id, op });
    setRowError(id, null);
    action()
      .catch((e: unknown) => setRowError(id, errorMessage(e)))
      .finally(() => setBusy(null));
  };

  const select = (m: ModelInfo) => {
    setSwitching(m.id);
    setSelectError(null);
    commands
      .selectModel(m.id)
      .catch((e: unknown) => setSelectError(errorMessage(e)))
      .finally(() => setSwitching(null));
  };

  const downloadingId = models?.find((m) => m.state === "downloading")?.id ?? null;

  return (
    <div className="flex flex-col gap-2.5">
      <FieldHeading
        label="モデル"
        help="文字起こしに使うモデルです。切り替えるとモデルを読み込み直し、その間は音声入力がオフになります"
      />
      {provisioning && !ready ? (
        <div
          data-testid="models-setup-incomplete"
          className="flex items-center gap-2.5 rounded-md bg-surface-muted px-3 py-2.5 text-xs text-fg-body"
        >
          <CircleAlert size={16} className="flex-none text-fg-muted" aria-hidden />
          <span className="flex-1 leading-[1.5]">
            セットアップが完了するまで、モデルの切り替えやダウンロードはできません。
          </span>
        </div>
      ) : null}
      {models ? (
        <Card>
          {models.map((m, i) => (
            <ModelRow
              key={m.id}
              model={m}
              last={i === models.length - 1}
              ready={ready}
              switching={switching}
              busyOp={busy?.id === m.id ? busy.op : null}
              downloadBlocked={downloadingId != null && downloadingId !== m.id}
              commandError={rowErrors[m.id] ?? null}
              onSelect={() => select(m)}
              onDownload={() => run(m.id, "download", () => commands.downloadModel(m.id))}
              onPause={() => run(m.id, "pause", () => commands.pauseModelDownload(m.id))}
              onCancel={() => run(m.id, "cancel", () => commands.cancelModelDownload(m.id))}
              onDelete={() => setDeleting(m)}
            />
          ))}
        </Card>
      ) : listError ? null : (
        <p className="m-0 text-sm text-fg-muted">確認しています…</p>
      )}
      <FieldError message={selectError ?? listError} />
      <DeleteModelDialog model={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

function ModelRow({
  model: m,
  last,
  ready,
  switching,
  busyOp,
  downloadBlocked,
  commandError,
  onSelect,
  onDownload,
  onPause,
  onCancel,
  onDelete,
}: {
  model: ModelInfo;
  last: boolean;
  ready: boolean;
  switching: string | null;
  busyOp: Op | null;
  /** 他のモデルが取得中 (同時に取得できるのは 1 つ) */
  downloadBlocked: boolean;
  commandError: string | null;
  onSelect: () => void;
  onDownload: () => void;
  onPause: () => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const busy = busyOp != null;
  const actions: ReactNode[] = [];

  if (switching === m.id) {
    actions.push(
      <Button key="switching" size="sm" loading>
        切り替えています…
      </Button>,
    );
  } else if (m.selected) {
    actions.push(
      <Badge key="in-use" tone="success" dot>
        使用中
      </Badge>,
    );
    if (m.state === "downloaded") {
      actions.push(
        <WithReason key="delete" reason={IN_USE}>
          <Button size="sm" disabled>
            削除
          </Button>
        </WithReason>,
      );
    }
  } else if (m.state === "downloaded") {
    const disabled = !ready || switching != null;
    actions.push(
      <Button key="select" size="sm" variant="primary" disabled={disabled} onClick={onSelect}>
        使う
      </Button>,
      <Button key="delete" size="sm" disabled={disabled} onClick={onDelete}>
        削除
      </Button>,
    );
  }

  if (m.state === "not_downloaded") {
    actions.push(
      <WithReason key="download" reason={ready && downloadBlocked ? DOWNLOADING_ELSEWHERE : null}>
        <Button size="sm" iconLeft={Download} disabled={!ready || downloadBlocked} loading={busyOp === "download"} onClick={onDownload}>
          ダウンロード
        </Button>
      </WithReason>,
    );
  } else if (m.state === "downloading") {
    actions.push(
      <Button key="pause" size="sm" iconLeft={Pause} disabled={!ready || busy} loading={busyOp === "pause"} onClick={onPause}>
        一時停止
      </Button>,
      <Button key="cancel" size="sm" iconLeft={X} disabled={!ready || busy} loading={busyOp === "cancel"} onClick={onCancel}>
        中止
      </Button>,
    );
  } else if (m.state === "paused" || m.state === "error") {
    actions.push(
      <WithReason key="resume" reason={ready && downloadBlocked ? DOWNLOADING_ELSEWHERE : null}>
        <Button
          size="sm"
          iconLeft={m.state === "error" ? RotateCw : Play}
          disabled={!ready || downloadBlocked || busy}
          loading={busyOp === "download"}
          onClick={onDownload}
        >
          {m.state === "error" ? "再試行" : "再開"}
        </Button>
      </WithReason>,
      <Button key="cancel" size="sm" iconLeft={X} disabled={!ready || busy} loading={busyOp === "cancel"} onClick={onCancel}>
        中止
      </Button>,
    );
  }

  return (
    <Row last={last} className="items-start">
      <div data-testid={`model-${m.id}`} data-state={m.state} className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-center gap-1.5 text-sm leading-[1.4] font-medium">
          {m.name}
          {m.recommended ? <Badge tone="primary">推奨</Badge> : null}
        </div>
        <span className="text-xs leading-[1.5] text-fg-muted">{m.description}</span>
        <ModelProgress model={m} />
        <FieldError message={commandError ?? (m.state === "error" ? m.error : null)} />
      </div>
      <div className="flex flex-none items-center gap-2 self-center">{actions}</div>
    </Row>
  );
}

/** 容量と取得の状態。取得途中は進捗バーを出す */
function ModelProgress({ model: m }: { model: ModelInfo }) {
  if (m.state === "not_downloaded" || m.state === "downloaded") {
    // 取得済みはディスク上の使用量、未取得は取得する量
    const bytes = m.state === "downloaded" ? m.diskBytes : m.sizeBytes;
    const label = m.state === "downloaded" ? "ダウンロード済み" : "未ダウンロード";
    return (
      <span className="tabular text-xs text-fg-muted">
        {label} ・ {formatBytes(bytes)}
      </span>
    );
  }
  const pct = m.sizeBytes > 0 ? Math.min(100, (m.bytesDone / m.sizeBytes) * 100) : 0;
  const pair = formatBytesPair(m.bytesDone, m.sizeBytes);
  const text =
    m.state === "downloading"
      ? `${pair} ・ ${m.etaSeconds != null ? formatEta(m.etaSeconds) : "残り時間を計算しています"}`
      : m.state === "paused"
        ? `一時停止中 ・ ${pair}`
        : `失敗 ・ ${pair}`;
  return (
    <div className="mt-0.5 flex flex-col gap-1">
      <div
        className="h-1.5 rounded-[3px] bg-meter-track"
        role="progressbar"
        aria-label={`${m.name} のダウンロード`}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn("h-1.5 rounded-[3px]", m.state === "downloading" ? "bg-action-primary" : "bg-gray-400")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="tabular text-xs text-fg-muted">{text}</span>
    </div>
  );
}

/** 押せない理由を Tooltip で示す (無効なボタンはポインターイベントを受けないため、外側の要素で受ける) */
function WithReason({ reason, children }: { reason: string | null; children: ReactNode }) {
  if (!reason) return <>{children}</>;
  return (
    <Tooltip content={reason}>
      <span tabIndex={0} aria-label={reason} className="inline-flex rounded-md outline-none focus-visible:shadow-[var(--focus-ring)]">
        {children}
      </span>
    </Tooltip>
  );
}

function DeleteModelDialog({ model, onClose }: { model: ModelInfo | null; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setError(null);
    onClose();
  };
  return (
    <Dialog open={model != null} onOpenChange={(o) => !o && !busy && close()}>
      <DialogContent>
        {model ? (
          <ConfirmLayout
            title="モデルを削除しますか？"
            description={`「${model.name}」（${formatBytes(model.diskBytes)}）を削除します。再び使うときはダウンロードし直します。`}
            error={error}
            actions={
              <>
                <Button disabled={busy} onClick={close}>
                  キャンセル
                </Button>
                <Button
                  variant="danger"
                  loading={busy}
                  onClick={() => {
                    setBusy(true);
                    setError(null);
                    commands
                      .deleteModel(model.id)
                      .then(close, (e: unknown) => setError(errorMessage(e)))
                      .finally(() => setBusy(false));
                  }}
                >
                  削除
                </Button>
              </>
            }
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
