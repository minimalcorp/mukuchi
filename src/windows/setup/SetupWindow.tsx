/*
 * 初回セットアップ (デザイン 04、560×440)。
 * ようこそ → 権限 → 実行環境とモデルのダウンロード → 動作テスト → 完了 の 5 ステップ。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AudioLines,
  Circle,
  CircleAlert,
  CircleCheck,
  CirclePause,
  Clock,
  Download,
  ExternalLink,
  Keyboard,
  LoaderCircle,
  Mic,
  Pause,
  Play,
  RotateCw,
  ShieldCheck,
} from "lucide-react";
import { TrafficLights, WindowFrame } from "@/components/app/window-frame";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { HelpTip } from "@/components/ui/tooltip";
import { useAudioLevel } from "@/lib/audio-level";
import { devOverrides } from "@/lib/env";
import { formatBytes, formatBytesPair, formatEta } from "@/lib/format";
import {
  errorMessage,
  isPermissionsGranted,
  useAppStatus,
  usePermissions,
  useProvisioning,
  useSettings,
} from "@/lib/hooks";
import { LaunchAtLoginError } from "@/components/app/launch-at-login-error";
import { commands, runCommand, subscribeEvents, type Permissions, type ProvisioningStatus } from "@/lib/ipc";
import { cn } from "@/lib/utils";

const STEPS = 5;

/** 導入の途中 (実行中・一時停止・失敗) か */
function inProgress(p: ProvisioningStatus): boolean {
  return p.stage !== "idle" && p.stage !== "done";
}

export function SetupWindow() {
  const [step, setStep] = useState(() => Math.min(STEPS, Math.max(1, devOverrides.setupStep ?? 1)));
  const provisioning = useProvisioning();
  // ウィンドウを閉じると破棄され、開き直すと最初のステップから始まる。
  // 導入が途中なら (閉じている間も Rust で進んでいる)、最初に状態が届いた時点でダウンロードのステップへ移る
  const [resumeChecked, setResumeChecked] = useState(false);
  if (!resumeChecked && provisioning) {
    setResumeChecked(true);
    if (step === 1 && devOverrides.setupStep == null && inProgress(provisioning)) setStep(3);
  }
  const next = () => setStep((s) => Math.min(STEPS, s + 1));
  const back = () => setStep((s) => Math.max(1, s - 1));

  return (
    <WindowFrame width={560} height={440}>
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          data-tauri-drag-region
          className="flex h-9 flex-none items-center gap-2 border-b border-line-subtle px-3.5"
        >
          <TrafficLights />
          <span className="flex-1" />
          <span data-tauri-drag-region className="text-xs text-fg-muted">
            mukuchi セットアップ
          </span>
          <span className="flex-1" />
          <span className="w-[52px]" />
        </header>
        <div className="flex gap-1 px-8 pt-4" aria-label={`${step} / ${STEPS}`}>
          {Array.from({ length: STEPS }, (_, i) => (
            <span
              key={i}
              className={cn("h-[3px] flex-1 rounded-[2px]", i < step ? "bg-action-primary" : "bg-progress-pending")}
            />
          ))}
        </div>
        {step === 1 && <WelcomeStep provisioning={provisioning} onNext={next} />}
        {step === 2 && <PermissionsStep onBack={back} onNext={next} />}
        {step === 3 && <DownloadStep provisioning={provisioning} onNext={next} />}
        {step === 4 && <TestStep onBack={back} onNext={next} />}
        {step === 5 && <DoneStep provisioning={provisioning} />}
      </div>
    </WindowFrame>
  );
}

function StepBody({ hero = false, dense = false, children }: { hero?: boolean; dense?: boolean; children: ReactNode }) {
  return (
    // 文言が長い場合にフッターへ重ならないよう、はみ出した分はスクロールさせる
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-y-auto px-8 pb-3",
        dense ? "gap-3" : "gap-3.5",
        hero ? "pt-10" : "pt-7",
      )}
    >
      {children}
    </div>
  );
}

function StepFooter({ align = "end", children }: { align?: "end" | "between"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex flex-none gap-2 border-t border-line-subtle px-6 py-4",
        align === "end" ? "justify-end" : "justify-between",
      )}
    >
      {children}
    </div>
  );
}

function Title({ large = false, children }: { large?: boolean; children: ReactNode }) {
  return (
    <h1 className={cn("m-0 leading-[1.25] font-semibold text-fg-strong", large ? "text-3xl" : "text-2xl")}>
      {children}
    </h1>
  );
}

function AppMark() {
  return (
    <div className="flex size-11 items-center justify-center rounded-[10px] bg-gray-900 text-gray-0 dark:bg-gray-700">
      <Mic size={20} aria-hidden />
    </div>
  );
}

/* ---------- 1. ようこそ ---------- */

function WelcomeStep({ provisioning, onNext }: { provisioning: ProvisioningStatus | null; onNext: () => void }) {
  // 容量は実測値 (デザインの 3.6 GB は仮)。取れない場合は容量を出さない
  const total = provisioning?.bytesTotal;
  return (
    <>
      <StepBody hero>
        <AppMark />
        <Title large>mukuchi へようこそ</Title>
        <p className="m-0 text-md leading-[1.6] text-fg-body">
          画面下のパネルで音声入力をオンにすると、話した内容が前面のアプリに入力されます。
        </p>
        <ul className="m-0 mt-1 flex list-none flex-col gap-2 p-0 text-sm text-fg-muted">
          <li className="flex items-center gap-2">
            <ShieldCheck size={16} aria-hidden />
            文字起こしはこの Mac の中で行い、音声は外部に送信しません
          </li>
          <li className="flex items-center gap-2">
            <Download size={16} aria-hidden />
            {total ? `実行環境とモデル（約 ${formatBytes(total)}）をダウンロードします` : "実行環境とモデルをダウンロードします"}
          </li>
          <li className="flex items-center gap-2">
            <Clock size={16} aria-hidden />
            所要時間の目安は 5〜10 分です
          </li>
        </ul>
      </StepBody>
      <StepFooter>
        <Button variant="primary" onClick={onNext}>
          はじめる
        </Button>
      </StepFooter>
    </>
  );
}

/* ---------- 2. 権限 ---------- */

function PermissionBadge({ granted }: { granted: boolean }) {
  return granted ? (
    <Badge tone="success" dot>
      許可済み
    </Badge>
  ) : (
    <Badge tone="warning" dot>
      未許可
    </Badge>
  );
}

function PermissionsStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  // システム設定での変更は通知されないことがあるため 1 秒ごとに再取得する
  const [perms, setPerms] = usePermissions(1000);
  const granted = isPermissionsGranted(perms);
  return (
    <>
      <StepBody>
        <Title>権限を許可してください</Title>
        <p className="m-0 text-sm leading-[1.6] text-fg-muted">2 つとも許可すると次に進めます。</p>
        <div className="flex flex-col rounded-lg border border-line-default">
          <div className="flex items-center gap-3 border-b border-line-subtle px-4 py-3.5">
            <Mic size={20} className="flex-none text-fg-muted" aria-hidden />
            <div className="flex flex-1 flex-col gap-0.5">
              <span className="text-md leading-[1.4] font-medium">マイク</span>
              <span className="text-xs leading-[1.4] text-fg-muted">発話を聞き取るために使います</span>
            </div>
            <PermissionBadge granted={perms?.microphone === "granted"} />
          </div>
          <div className="flex items-center gap-3 px-4 py-3.5">
            <Keyboard size={20} className="flex-none text-fg-muted" aria-hidden />
            <div className="flex flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-md leading-[1.4] font-medium">
                アクセシビリティ
                <HelpTip content="他のアプリのカーソル位置に文字とキー操作を送るために必要です" />
              </span>
              <span className="text-xs leading-[1.4] text-fg-muted">文字の入力に使います</span>
            </div>
            <PermissionBadge granted={!!perms?.accessibility} />
          </div>
        </div>
        {perms && !granted ? <PermissionGuide perms={perms} onChange={setPerms} /> : null}
      </StepBody>
      <StepFooter align="between">
        <Button variant="ghost" onClick={onBack}>
          戻る
        </Button>
        <Button variant="primary" disabled={!granted} onClick={onNext}>
          次へ
        </Button>
      </StepFooter>
    </>
  );
}

/** 未許可の権限への案内。先に未許可のマイク、次にアクセシビリティの順で 1 つずつ出す */
function PermissionGuide({ perms, onChange }: { perms: Permissions; onChange: (p: Permissions) => void }) {
  let text: string;
  let button: ReactNode;
  if (perms.microphone === "not_determined") {
    text = "マイクの使用を許可してください。確認のダイアログが表示されます。";
    button = (
      <Button size="sm" onClick={() => commands.requestMicrophone().then(onChange, () => {})}>
        許可する
      </Button>
    );
  } else if (perms.microphone === "denied") {
    text = "システム設定のマイクで mukuchi をオンにしてください。許可するとここに自動で反映されます。";
    button = (
      <Button size="sm" iconRight={ExternalLink} onClick={() => runCommand(commands.openSystemSettings("microphone"))}>
        システム設定を開く
      </Button>
    );
  } else {
    text = "システム設定で mukuchi をオンにしてください。許可するとここに自動で反映されます。";
    button = (
      <Button size="sm" iconRight={ExternalLink} onClick={() => runCommand(commands.openSystemSettings("accessibility"))}>
        システム設定を開く
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2.5 rounded-md bg-surface-muted px-3 py-2.5 text-xs text-fg-body">
      <span className="flex-1 leading-[1.5]">{text}</span>
      {button}
    </div>
  );
}

/* ---------- 3. ダウンロード ---------- */

type ProvisioningItem = ProvisioningStatus["items"][number];

const ITEM_LABEL: Record<ProvisioningItem["id"], string> = {
  runtime: "Python 実行環境",
  model: "Qwen3-ASR（日本語追加学習）",
  verify: "動作確認",
};

const RUNNING_TEXT: Record<ProvisioningItem["id"], string> = {
  runtime: "準備しています…",
  // model の大きさはファイル一覧を取得するまで分からない
  model: "ファイル一覧を取得しています…",
  verify: "確認しています…",
};

function isRunning(p: ProvisioningStatus): boolean {
  return p.stage === "runtime" || p.stage === "model" || p.stage === "verify";
}

/** 全体の行の右側。バイト数は model のみ (runtime・verify は大きさが分からない) */
function summaryText(p: ProvisioningStatus): string {
  const parts: string[] = [];
  if (p.bytesTotal != null) parts.push(`${formatBytes(p.bytesDone)} / ${formatBytes(p.bytesTotal)}`);
  if (p.stage === "runtime" || (p.stage === "idle" && p.bytesTotal == null)) parts.push("実行環境を準備しています");
  if (p.stage === "model") parts.push(p.etaSeconds != null ? formatEta(p.etaSeconds) : "残り時間を計算しています");
  if (p.stage === "verify") parts.push("動作を確認しています");
  if (p.stage === "paused") parts.push("一時停止中");
  return parts.join(" ・ ");
}

function itemRight(item: ProvisioningItem, stage: ProvisioningStatus["stage"]): string {
  if (item.state === "pending") return "待機中";
  if (item.state === "done") return item.bytesTotal != null ? formatBytes(item.bytesTotal) : "完了";
  if (item.bytesTotal != null) return formatBytesPair(item.bytesDone, item.bytesTotal);
  if (stage === "paused") return "一時停止中";
  if (stage === "error") return "失敗";
  return RUNNING_TEXT[item.id];
}

function DownloadStep({ provisioning: p, onNext }: { provisioning: ProvisioningStatus | null; onNext: () => void }) {
  const started = useRef(false);
  // 一時停止は止まるまで待って返るため、その間はボタンを押せなくする
  const [pausing, setPausing] = useState(false);
  // command 自体の失敗 (導入の失敗は stage=error で届く)
  const [commandError, setCommandError] = useState<string | null>(null);

  const start = () => {
    setCommandError(null);
    commands.startProvisioning().catch((e: unknown) => setCommandError(errorMessage(e)));
  };
  useEffect(() => {
    // このステップに来た時点で未開始なら開始する
    if (p?.stage === "idle" && !started.current) {
      started.current = true;
      commands.startProvisioning().catch((e: unknown) => setCommandError(errorMessage(e)));
    }
  }, [p?.stage]);

  if (!p) {
    return (
      <StepBody dense>
        <Title>実行環境とモデルのダウンロード</Title>
        <p className="m-0 text-sm text-fg-muted">状態を確認しています…</p>
      </StepBody>
    );
  }

  const done = p.stage === "done";
  const paused = p.stage === "paused";
  const failed = p.stage === "error";
  const running = isRunning(p);
  const pct = p.bytesTotal ? Math.min(100, (p.bytesDone / p.bytesTotal) * 100) : 0;
  // model は途中のファイルから続きを取る。runtime・verify はやり直すため取得済みの量は示さない
  const stoppedModel = p.items.find((i) => i.id === "model" && i.state === "active");
  const resumeBytes = stoppedModel?.bytesDone ?? 0;

  return (
    <>
      <StepBody dense>
        <Title>
          {done
            ? "実行環境とモデルの準備ができました"
            : paused
              ? "ダウンロードを一時停止しました"
              : failed
                ? "準備を完了できませんでした"
                : "実行環境とモデルをダウンロードしています"}
        </Title>
        <div className="flex flex-col gap-2">
          <div className="flex justify-between gap-3 text-sm">
            <span>全体</span>
            <span className="tabular text-fg-muted">{summaryText(p)}</span>
          </div>
          <div
            className="h-1.5 rounded-[3px] bg-meter-track"
            role="progressbar"
            aria-label="全体の進捗"
            aria-valuenow={Math.round(pct)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="h-1.5 rounded-[3px] bg-action-primary" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="flex flex-col rounded-lg border border-line-default text-sm">
          {p.items.map((item, i) => {
            const last = i === p.items.length - 1;
            const active = item.state === "active";
            const Icon =
              item.state === "done"
                ? CircleCheck
                : active && failed
                  ? CircleAlert
                  : active && paused
                    ? CirclePause
                    : active
                      ? LoaderCircle
                      : Circle;
            return (
              <div
                key={item.id}
                data-testid={`provisioning-item-${item.id}`}
                data-state={item.state}
                className={cn(
                  "flex items-center gap-2.5 px-3.5 py-2.5",
                  !last && "border-b border-line-subtle",
                  item.state === "pending" && "text-fg-muted",
                )}
              >
                <Icon
                  size={16}
                  className={cn(
                    "flex-none",
                    item.state === "done" && "text-green-500",
                    active && (failed ? "text-red-500" : paused ? "text-fg-muted" : "text-blue-500"),
                    active && running && "animate-spin",
                  )}
                  aria-hidden
                />
                <span className="flex-1">{ITEM_LABEL[item.id]}</span>
                <span className={cn(item.state !== "pending" && "tabular text-fg-muted")}>{itemRight(item, p.stage)}</span>
              </div>
            );
          })}
        </div>
        {failed ? (
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-md bg-tone-danger-bg px-3 py-2.5 text-xs text-tone-danger-fg"
          >
            <CircleAlert size={16} className="mt-0.5 flex-none" aria-hidden />
            <span className="flex-1 leading-[1.5]">
              {p.error ?? "準備に失敗しました。"}
              {resumeBytes > 0 ? `取得済みの ${formatBytes(resumeBytes)} から再開します。` : ""}
            </span>
            <Button size="sm" iconLeft={RotateCw} onClick={start}>
              再試行
            </Button>
          </div>
        ) : null}
        {commandError ? (
          <p role="alert" className="m-0 text-xs leading-[1.5] text-fg-danger">
            {commandError}
          </p>
        ) : null}
      </StepBody>
      <StepFooter align="between">
        {paused ? (
          <Button iconLeft={Play} onClick={start}>
            再開
          </Button>
        ) : (
          <Button
            iconLeft={Pause}
            loading={pausing}
            disabled={!running}
            onClick={() => {
              setPausing(true);
              setCommandError(null);
              commands
                .pauseProvisioning()
                .catch((e: unknown) => setCommandError(errorMessage(e)))
                .finally(() => setPausing(false));
            }}
          >
            一時停止
          </Button>
        )}
        {/* 動作確認まで済んでから (stage=done) 次へ進める。complete_setup はその後でしか呼ばない */}
        <Button variant="primary" disabled={!done} onClick={onNext}>
          次へ
        </Button>
      </StepFooter>
    </>
  );
}

/* ---------- 4. 動作テスト ---------- */

function TestStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const status = useAppStatus();
  const { level } = useAudioLevel();
  const [recognized, setRecognized] = useState(false);
  // 音声コマンドは欄にキー操作として届くため、何を送ったかをバッジで示す
  const [commandsSent, setCommandsSent] = useState<{ id: number; text: string; key: string }[]>([]);
  const on = status != null && ["listening", "speaking", "finalizing", "done"].includes(status.phase);

  useEffect(
    () =>
      subscribeEvents({
        "utterance-result": (r) => {
          if (r.kind === "inserted") setRecognized(true);
          if (r.kind === "command") {
            setRecognized(true);
            setCommandsSent((list) => [...list, { id: r.id, text: r.text, key: r.key }]);
          }
        },
      }),
    [],
  );

  return (
    <>
      <StepBody>
        <Title>試しに話してみてください</Title>
        <p className="m-0 text-sm leading-[1.6] text-fg-muted">
          画面下のパネルでオンにして、「今日は晴れています」のように話してください。
        </p>
        <div className="flex h-8 flex-none items-center gap-2.5 rounded-md bg-surface-muted px-3">
          <AudioLines size={16} className="flex-none text-blue-500" aria-hidden />
          <div className="h-1 flex-1 rounded-[2px] bg-meter-track-strong">
            <div className="h-1 rounded-[2px] bg-green-500" style={{ width: `${(on ? level : 0) * 100}%` }} />
          </div>
          <span className="text-xs text-fg-muted">入力レベル</span>
        </div>
        {/* 実際の入力先。前面のこの欄に Rust から貼り付けられる */}
        <div className="flex min-h-[88px] flex-col rounded-md border border-line-default px-3 py-2 transition-control focus-within:border-line-focus focus-within:shadow-[var(--focus-ring)]">
          <textarea
            autoFocus
            aria-label="テスト入力欄"
            rows={2}
            className="w-full flex-1 resize-none border-0 bg-transparent p-0 pt-1 text-md leading-[1.6] text-fg-strong outline-none focus-visible:outline-none"
          />
          {commandsSent.length > 0 ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-1 text-md leading-[1.6] text-fg-strong">
              {commandsSent.map((c) => (
                <span key={c.id} className="inline-flex items-center gap-2">
                  {c.text}
                  <Badge tone="violet">{c.key} を送信</Badge>
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {recognized ? (
          <div className="flex items-center gap-1.5 text-xs text-fg-success">
            <CircleCheck size={14} aria-hidden />
            正しく認識できました。
          </div>
        ) : null}
      </StepBody>
      <StepFooter align="between">
        <Button variant="ghost" onClick={onBack}>
          戻る
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onNext}>
            スキップ
          </Button>
          <Button variant="primary" onClick={onNext}>
            次へ
          </Button>
        </div>
      </StepFooter>
    </>
  );
}

/* ---------- 5. 完了 ---------- */

function DoneStep({ provisioning }: { provisioning: ProvisioningStatus | null }) {
  const [settings, update, settingsErrors] = useSettings();
  const [completeError, setCompleteError] = useState<string | null>(null);
  // 導入が済むまで (動作確認の成功まで) はセットアップを完了させない
  const ready = provisioning?.stage === "done";
  return (
    <>
      <StepBody hero>
        <div className="flex size-11 items-center justify-center rounded-full bg-tone-success-bg text-green-500">
          <CircleCheck size={20} aria-hidden />
        </div>
        <Title large>準備ができました</Title>
        <p className="m-0 text-md leading-[1.6]">
          mukuchi はメニューバーに常駐します。設定はメニューバーのアイコンから開けます。
        </p>
        <div className="flex items-center gap-2.5 rounded-lg border border-line-default px-3.5 py-3 text-sm">
          <span className="flex-1">オン／オフは画面下のパネルか、メニューバーのアイコンから切り替えます</span>
        </div>
        <Switch
          label="ログイン時に起動"
          checked={settings?.launchAtLogin ?? true}
          disabled={!settings}
          onCheckedChange={(v) => update({ launchAtLogin: v })}
        />
        <LaunchAtLoginError message={settingsErrors.launchAtLogin} />
        {completeError ? (
          <p role="alert" className="m-0 text-xs leading-[1.5] text-fg-danger">
            {completeError}
          </p>
        ) : null}
      </StepBody>
      <StepFooter>
        <Button
          variant="primary"
          disabled={!ready}
          onClick={() => {
            setCompleteError(null);
            commands.completeSetup().catch((e: unknown) => setCompleteError(errorMessage(e)));
          }}
        >
          閉じる
        </Button>
      </StepFooter>
    </>
  );
}
