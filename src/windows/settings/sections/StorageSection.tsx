import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { formatBytes } from "@/lib/format";
import { commands, type StorageUsage, type UninstallTarget } from "@/lib/ipc";
import { Card, TitleWithSub } from "./common";

export function StorageSection() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [confirm, setConfirm] = useState<"delete" | "uninstall" | null>(null);
  const refresh = () => {
    commands.getStorageUsage().then(setUsage, () => {});
  };
  useEffect(refresh, []);

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
      </div>
      <Card>
        <div className="flex items-center gap-3 border-b border-line-subtle px-3.5 py-3">
          <TitleWithSub
            title="実行環境とモデルのみ削除"
            sub="設定は残ります。次回オンにしたときに再ダウンロードします。"
          />
          <Button size="sm" disabled={!usage || usage.runtimeBytes + usage.modelBytes === 0} onClick={() => setConfirm("delete")}>
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
        onClose={() => setConfirm(null)}
        onDone={() => {
          setConfirm(null);
          refresh();
        }}
      />
      <UninstallDialog open={confirm === "uninstall"} onClose={() => setConfirm(null)} />
    </>
  );
}

function ConfirmLayout({
  title,
  description,
  children,
  actions,
}: {
  title: string;
  description: string;
  children?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <>
      <div className="flex flex-col gap-2 px-5 pt-5">
        <DialogTitle className="m-0 text-lg leading-[1.4] font-semibold text-fg-strong">{title}</DialogTitle>
        <DialogDescription className="m-0 text-sm text-fg-muted">{description}</DialogDescription>
      </div>
      {children ?? <div className="h-3.5" />}
      <div className="flex justify-end gap-2 px-5 pb-5">{actions}</div>
    </>
  );
}

function DeleteRuntimeDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <ConfirmLayout
          title="実行環境とモデルを削除しますか？"
          description="設定は残ります。次回オンにしたときに再ダウンロードします。"
          actions={
            <>
              <Button disabled={busy} onClick={onClose}>
                キャンセル
              </Button>
              <Button
                variant="danger"
                loading={busy}
                onClick={() => {
                  setBusy(true);
                  commands
                    .deleteRuntimeAndModel()
                    .then(onDone, () => {})
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
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) commands.getUninstallTargets().then(setTargets, () => setTargets([]));
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <ConfirmLayout
          title="mukuchi を完全にアンインストールしますか？"
          description="以下を削除します。この操作は取り消せません。"
          actions={
            <>
              <Button disabled={busy} onClick={onClose}>
                キャンセル
              </Button>
              <Button
                variant="danger"
                loading={busy}
                disabled={!targets}
                onClick={() => {
                  // 完了するとアプリは終了する
                  setBusy(true);
                  commands.uninstall().catch(() => setBusy(false));
                }}
              >
                アンインストール
              </Button>
            </>
          }
        >
          <div
            data-testid="uninstall-targets"
            className="mx-5 my-3.5 flex max-h-[220px] flex-col overflow-y-auto rounded-md border border-line-default font-mono text-xs"
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
            {targets === null ? <div className="px-2.5 py-[7px] text-fg-muted">確認しています…</div> : null}
          </div>
        </ConfirmLayout>
      </DialogContent>
    </Dialog>
  );
}
