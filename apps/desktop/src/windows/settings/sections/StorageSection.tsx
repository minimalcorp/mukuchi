import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { formatBytes } from "@/lib/format";
import { errorMessage } from "@/lib/hooks";
import { commands, runCommand, type AppStatus, type StorageUsage, type UninstallTarget } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { Card, ConfirmLayout, FieldError, TitleWithSub } from "./common";

export function StorageSection({ status }: { status: AppStatus | null }) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"delete" | "uninstall" | null>(null);
  const closeConfirm = useCallback(() => setConfirm(null), []);
  const refresh = useCallback(() => {
    commands.getStorageUsage().then(
      (u) => {
        setUsage(u);
        setUsageError(null);
      },
      (e: unknown) => setUsageError(errorMessage(e)),
    );
  }, []);
  // 削除後やセットアップの完了で実行環境の有無が変わったら取り直す
  const runtimeMissing = status?.error?.code === "runtime_missing";
  useEffect(refresh, [refresh, runtimeMissing]);

  const total = usage ? usage.runtimeBytes + usage.modelBytes + usage.otherBytes : 0;
  const parts = usage
    ? [
        { label: "Python 実行環境", bytes: usage.runtimeBytes, color: "bg-blue-500" },
        { label: "モデル", bytes: usage.modelBytes, color: "bg-cyan-500" },
        { label: "設定とログ", bytes: usage.otherBytes, color: "bg-gray-400" },
      ]
    : [];

  return (
    <>
      <div className="flex flex-col gap-2.5">
        <div className="flex items-baseline gap-2">
          <span className="tabular text-3xl leading-[1.25] font-semibold text-fg-strong">
            {usage ? formatBytes(total) : "—"}
          </span>
          <span className="text-xs text-fg-muted">使用中</span>
        </div>
        <div className="flex h-2 gap-0.5 overflow-hidden rounded-[4px] bg-meter-track" aria-hidden>
          {total > 0
            ? parts.map((p) =>
                p.bytes > 0 ? (
                  <span key={p.label} className={p.color} style={{ width: `${Math.max(1, (p.bytes / total) * 100)}%` }} />
                ) : null,
              )
            : null}
        </div>
        {usage ? (
          <Card className="text-sm">
            {parts.map((p, i) => (
              <div
                key={p.label}
                className={`flex items-center gap-2.5 px-3.5 py-2.5 ${i < parts.length - 1 ? "border-b border-line-subtle" : ""}`}
              >
                <span className={`size-2 rounded-[2px] ${p.color}`} aria-hidden />
                <span className="flex-1">{p.label}</span>
                <span className="tabular text-fg-muted">{formatBytes(p.bytes)}</span>
              </div>
            ))}
          </Card>
        ) : null}
        <FieldError message={usageError} />
      </div>
      {runtimeMissing ? (
        <div
          data-testid="runtime-missing"
          className="flex items-center gap-2.5 rounded-md bg-surface-muted px-3 py-2.5 text-xs text-fg-body"
        >
          <CircleAlert size={16} className="flex-none text-fg-muted" aria-hidden />
          <span className="flex-1 leading-[1.5]">
            実行環境とモデルがありません。音声入力を使うには、セットアップでダウンロードし直してください。
          </span>
          <Button size="sm" iconLeft={Download} onClick={() => runCommand(commands.openSetup())}>
            セットアップを開く
          </Button>
        </div>
      ) : null}
      <Card>
        <div className="flex items-center gap-3 border-b border-line-subtle px-3.5 py-3">
          <TitleWithSub
            title="実行環境とモデルのみ削除"
            sub="設定は残ります。再び使うにはセットアップが必要です。"
          />
          <Button
            size="sm"
            disabled={!usage || usage.runtimeBytes + usage.modelBytes === 0}
            onClick={() => setConfirm("delete")}
          >
            削除
          </Button>
        </div>
        <div className="flex items-center gap-3 px-3.5 py-3">
          <TitleWithSub title="完全にアンインストール" sub="すべてのデータとアプリ本体を削除します。" />
          <Button size="sm" variant="danger" onClick={() => setConfirm("uninstall")}>
            アンインストール…
          </Button>
        </div>
      </Card>
      <DeleteRuntimeDialog
        open={confirm === "delete"}
        onClose={closeConfirm}
        onDone={() => {
          setConfirm(null);
          refresh();
        }}
      />
      <UninstallDialog open={confirm === "uninstall"} onClose={closeConfirm} />
    </>
  );
}

function DeleteRuntimeDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setError(null);
    onClose();
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && close()}>
      <DialogContent>
        <ConfirmLayout
          title="実行環境とモデルを削除しますか？"
          description="音声入力は使えなくなります。設定とログは残ります。再び使うときはセットアップからダウンロードし直します。"
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
                    .deleteRuntimeAndModel()
                    .then(onDone, (e: unknown) => setError(errorMessage(e)))
                    .finally(() => setBusy(false));
                }}
              >
                削除
              </Button>
            </>
          }
        />
      </DialogContent>
    </Dialog>
  );
}

function UninstallDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [targets, setTargets] = useState<UninstallTarget[] | null>(null);
  // running: 実行中 (取り消せない)。done: 返った (実機は成功すると終了するため、開発用の dry run でだけ見える)
  const [phase, setPhase] = useState<"confirm" | "running" | "done">("confirm");
  const [error, setError] = useState<string | null>(null);
  const running = phase === "running";
  const close = () => {
    // 次に開いた時は一覧を取り直す (消えた・増えたものを反映する)
    setTargets(null);
    setError(null);
    setPhase("confirm");
    onClose();
  };
  useEffect(() => {
    if (!open) return;
    commands.getUninstallTargets().then(setTargets, (e: unknown) => {
      // 削除対象を示せない状態ではアンインストールさせない (targets は null のまま)
      setError(errorMessage(e));
    });
  }, [open]);

  const totalBytes = (targets ?? []).reduce((sum, t) => sum + t.bytes, 0);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !running && close()}>
      <DialogContent>
        <ConfirmLayout
          title="mukuchi を完全にアンインストールしますか？"
          description={
            phase === "done"
              ? "アンインストールしました。アプリを終了します。"
              : running
                ? "アンインストールしています… 完了するとアプリが終了します。"
                : "以下を削除します。この操作は取り消せません。"
          }
          error={error}
          actions={
            phase === "done" ? (
              <Button onClick={close}>閉じる</Button>
            ) : (
              <>
                <Button disabled={running} onClick={close}>
                  キャンセル
                </Button>
                <Button
                  variant="danger"
                  loading={running}
                  disabled={!targets}
                  onClick={() => {
                    setPhase("running");
                    setError(null);
                    commands.uninstall().then(
                      () => setPhase("done"),
                      (e: unknown) => {
                        // 失敗しても残りの削除は続いている。本体を消せなかった等の理由を示し、閉じられるようにする
                        setPhase("confirm");
                        setError(errorMessage(e));
                      },
                    );
                  }}
                >
                  アンインストール
                </Button>
              </>
            )
          }
        >
          <div
            data-testid="uninstall-targets"
            aria-busy={running}
            className={cn(
              "mx-5 my-3.5 flex max-h-[220px] flex-col overflow-y-auto rounded-md border border-line-default font-mono text-xs",
              running && "opacity-60",
            )}
          >
            {(targets ?? []).map((t, i, all) => (
              <div
                key={t.path}
                className={`flex gap-2 px-2.5 py-[7px] ${i < all.length - 1 ? "border-b border-line-subtle" : ""}`}
              >
                <span className="flex-1 truncate" title={t.path}>
                  {t.path}
                </span>
                <span className="tabular flex-none text-fg-muted">{formatBytes(t.bytes)}</span>
              </div>
            ))}
            {targets === null && !error ? (
              <div className="px-2.5 py-[7px] text-fg-muted">確認しています…</div>
            ) : null}
          </div>
          {targets && targets.length > 0 ? (
            <div className="mx-5 -mt-1.5 mb-3.5 flex justify-between text-xs text-fg-muted">
              <span>{targets.length} 項目（ログイン項目と権限の許可も解除します）</span>
              <span className="tabular">合計 {formatBytes(totalBytes)}</span>
            </div>
          ) : null}
        </ConfirmLayout>
      </DialogContent>
    </Dialog>
  );
}
