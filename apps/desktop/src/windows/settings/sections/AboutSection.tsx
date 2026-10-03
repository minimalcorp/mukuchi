import { useEffect, useState } from "react";
import { ChevronRight, FolderOpen, RefreshCw, RotateCw } from "lucide-react";
import { AppLogo } from "@/components/app/app-logo";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { formatBytes, formatBytesPair, formatCheckedAt } from "@/lib/format";
import { errorMessage, useUpdateStatus } from "@/lib/hooks";
import { commands, runCommand, type AppInfo, type UpdateStatus } from "@/lib/ipc";
// アプリ本体のライセンス (リポジトリ直下の LICENSE)。オフラインで表示できるようバンドルに含める。
// dev サーバーは pnpm-workspace.yaml のあるリポジトリ直下を server.fs.allow の既定に含めるため読める
import licenseText from "../../../../../../LICENSE?raw";
import { Card, FieldError, Row, TitleWithSub, type SectionProps } from "./common";

export function AboutSection({ settings, update, errors }: SectionProps) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [license, setLicense] = useState(false);
  useEffect(() => {
    commands.getAppInfo().then(setInfo, () => {});
  }, []);

  return (
    <>
      <div className="flex items-center gap-3.5">
        <AppLogo size={48} />
        <div className="flex flex-col gap-0.5">
          <span className="text-lg leading-[1.4] font-semibold text-fg-strong">mukuchi</span>
          <span className="font-mono text-xs text-fg-muted">
            {info ? `バージョン ${info.version}（build ${info.build}）` : " "}
          </span>
        </div>
      </div>
      <UpdateBlock
        autoCheck={settings.autoCheckUpdates}
        onAutoCheckChange={(v) => update({ autoCheckUpdates: v })}
        autoCheckError={errors.autoCheckUpdates}
      />
      <Card className="text-sm">
        <div className="flex items-center border-b border-line-subtle px-3.5 py-2.5">
          <span className="flex-1">ライセンス</span>
          <Button size="sm" variant="ghost" iconRight={ChevronRight} onClick={() => setLicense(true)}>
            表示
          </Button>
        </div>
        <div className="flex items-center px-3.5 py-2.5">
          <span className="flex-1">ログ</span>
          <Button size="sm" variant="ghost" iconLeft={FolderOpen} onClick={() => runCommand(commands.openLogsFolder())}>
            Finder で開く
          </Button>
        </div>
      </Card>
      <Dialog open={license} onOpenChange={setLicense}>
        <DialogContent className="w-[560px]">
          <div className="flex flex-col gap-2 px-5 pt-5">
            <DialogTitle className="m-0 text-lg leading-[1.4] font-semibold text-fg-strong">ライセンス</DialogTitle>
            <DialogDescription className="m-0 text-sm text-fg-muted">Apache License 2.0</DialogDescription>
          </div>
          <pre className="mx-5 my-3.5 max-h-[300px] overflow-auto rounded-md border border-line-default p-3 font-mono text-2xs leading-[1.5] whitespace-pre-wrap text-fg-body select-text">
            {licenseText}
          </pre>
          <div className="flex justify-end px-5 pb-5">
            <Button onClick={() => setLicense(false)}>閉じる</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** 「1.2.0」「v1.2.0」のどちらで届いても「v1.2.0」で出す */
function ver(v: string): string {
  return v.startsWith("v") ? v : `v${v}`;
}

/**
 * アップデート (docs/architecture.md「アップデート」)。状態は Rust の UpdateStatus をそのまま表示し、
 * この画面が持つのは応答待ちの操作と command の失敗だけ
 */
function UpdateBlock({
  autoCheck,
  onAutoCheckChange,
  autoCheckError,
}: {
  autoCheck: boolean;
  onAutoCheckChange: (v: boolean) => void;
  autoCheckError: string | undefined;
}) {
  const { status, error: statusError, applyResponse } = useUpdateStatus();
  const [busy, setBusy] = useState<"check" | "install" | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);

  const run = (op: "check" | "install", action: () => Promise<void>) => {
    setBusy(op);
    setCommandError(null);
    action()
      .catch((e: unknown) => setCommandError(errorMessage(e)))
      .finally(() => setBusy(null));
  };

  const state = status?.state ?? null;
  // 取得中は Rust も何もしないため押させない (確認中は loading)。unavailable は確認自体ができない
  const checkDisabled = state == null || state === "unavailable" || state === "downloading";
  const installing = busy === "install" || state === "installing";

  return (
    <section className="flex flex-col gap-2.5">
      <h2 className="m-0 text-xs font-semibold text-fg-muted">アップデート</h2>
      <Card>
        <Row className="flex-col items-stretch gap-2">
          <div className="flex items-center gap-3">
            <div data-testid="update-status" data-state={state ?? "loading"} className="flex min-w-0 flex-1 flex-col gap-1">
              {status ? <UpdateStatusView status={status} /> : statusError ? null : (
                <span className="text-sm leading-[1.4] text-fg-muted">確認しています…</span>
              )}
              <FieldError message={statusError} />
            </div>
            {/* ready の後も確認はできるが (さらに新しい版があれば取り直す)、操作を1つに絞るため出さない。自動の確認が続く */}
            {state === "ready" || state === "installing" ? (
              <Button
                size="sm"
                variant="primary"
                iconLeft={RotateCw}
                loading={installing}
                onClick={() => run("install", () => commands.installUpdate())}
              >
                再起動してアップデート
              </Button>
            ) : (
              <Button
                size="sm"
                iconLeft={RefreshCw}
                loading={busy === "check" || state === "checking"}
                disabled={checkDisabled}
                onClick={() => run("check", () => applyResponse(commands.checkForUpdate()))}
              >
                アップデートを確認
              </Button>
            )}
          </div>
          {/* リリースノートは幅を取るため、ボタンの下に全幅で出す */}
          {state === "ready" && status?.notes ? (
            <p
              data-testid="update-notes"
              className="m-0 max-h-24 overflow-auto rounded-md bg-surface-muted px-3 py-2 text-xs leading-[1.5] whitespace-pre-wrap text-fg-body select-text"
            >
              {status.notes}
            </p>
          ) : null}
        </Row>
        <Row last>
          <TitleWithSub
            title="自動でアップデートを確認"
            sub="起動時と 6 時間ごとに確認し、新しいバージョンをダウンロードしておきます"
          />
          <Switch aria-label="自動でアップデートを確認" checked={autoCheck} onCheckedChange={onAutoCheckChange} />
        </Row>
      </Card>
      {/* 失敗した操作は Rust が error に遷移させ同じ文言を状態にも載せるため、error の間は二重に出さない */}
      <FieldError message={(state === "error" ? null : commandError) ?? autoCheckError} />
    </section>
  );
}

function UpdateStatusView({ status: s }: { status: UpdateStatus }) {
  const latest = s.latestVersion ? ver(s.latestVersion) : null;
  const title = (text: string) => <span className="text-sm leading-[1.4] font-medium">{text}</span>;
  const sub = (text: string) => <span className="tabular text-xs leading-[1.5] text-fg-muted">{text}</span>;

  switch (s.state) {
    case "unavailable":
      // 理由 (dmg から起動している等) は失敗ではないため、エラーの色にしない
      return (
        <>
          {title("自動アップデートは使えません")}
          {s.error ? sub(s.error) : null}
        </>
      );
    case "idle":
      return s.checkedAt != null ? (
        <>
          {title("最新のバージョンです")}
          {sub(`最終確認 ${formatCheckedAt(s.checkedAt)}`)}
        </>
      ) : (
        <>
          {title("まだ確認していません")}
          {sub(`現在のバージョン ${ver(s.currentVersion)}`)}
        </>
      );
    case "checking":
      return title("アップデートを確認しています…");
    case "downloading": {
      const pct = s.bytesTotal ? Math.min(100, (s.bytesDone / s.bytesTotal) * 100) : null;
      return (
        <>
          {title(latest ? `${latest} をダウンロードしています` : "アップデートをダウンロードしています")}
          {pct != null ? (
            <div
              className="mt-0.5 h-1.5 rounded-[3px] bg-meter-track"
              role="progressbar"
              aria-label="アップデートのダウンロード"
              aria-valuenow={Math.round(pct)}
              aria-valuemin={0}
              aria-valuemax={100}
            >
              <div className="h-1.5 rounded-[3px] bg-action-primary" style={{ width: `${pct}%` }} />
            </div>
          ) : null}
          {sub(s.bytesTotal ? formatBytesPair(s.bytesDone, s.bytesTotal) : formatBytes(s.bytesDone))}
        </>
      );
    }
    case "ready":
      return (
        <>
          {title(latest ? `${latest} の準備ができました` : "アップデートの準備ができました")}
          {sub(`再起動するとアップデートします（現在 ${ver(s.currentVersion)}）`)}
        </>
      );
    case "installing":
      return (
        <>
          {title(latest ? `${latest} をインストールしています…` : "アップデートをインストールしています…")}
          {sub("完了すると自動で再起動します")}
        </>
      );
    case "error":
      return (
        <>
          {title(latest ? `${latest} へのアップデートに失敗しました` : "アップデートの確認に失敗しました")}
          <FieldError message={s.error} />
        </>
      );
  }
}
