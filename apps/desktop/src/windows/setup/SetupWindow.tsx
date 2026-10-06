/*
 * 初回セットアップ (デザイン 04、560×440)。
 * ようこそ → 権限 → 実行環境とモデルのダウンロード → 入力モード → 動作テスト → 完了 の 6 ステップ。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AudioLines,
  Check,
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
import { AppLogo } from "@/components/app/app-logo";
import { TrafficLights, WindowFrame } from "@/components/app/window-frame";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { InputModeRadio } from "@/components/app/input-mode-options";
import { Select } from "@/components/ui/select";
import { ShortcutKeys, ShortcutRecorder } from "@/components/app/shortcut-recorder";
import { HelpTip } from "@/components/ui/tooltip";
import { useAudioLevel } from "@/lib/audio-level";
import { useLevelEnvelope } from "@/lib/level-envelope";
import { devOverrides } from "@/lib/env";
import { formatBytes, formatBytesPair, formatEta } from "@/lib/format";
import { useI18n, type Messages } from "@/i18n/context";
import { isLocale, LOCALE_AUTONYMS, LOCALES } from "@/i18n/locales";
import { SAMPLE_PHRASES } from "@/i18n/speech";
import {
  errorMessage,
  isPermissionsGranted,
  useAppStatus,
  useModels,
  usePermissions,
  useProvisioning,
  useSettings,
} from "@/lib/hooks";
import { LaunchAtLoginError } from "@/components/app/launch-at-login-error";
import {
  commands,
  runCommand,
  subscribeEvents,
  type InputMode,
  type Locale,
  type ModelInfo,
  type Permissions,
  type ProvisioningStatus,
} from "@/lib/ipc";
import { cn } from "@/lib/utils";

const STEPS = 6;

/** 導入の途中 (実行中・一時停止・失敗) か */
function inProgress(p: ProvisioningStatus): boolean {
  return p.stage !== "idle" && p.stage !== "done";
}

export function SetupWindow() {
  const { t } = useI18n();
  const [step, setStep] = useState(() => Math.min(STEPS, Math.max(1, devOverrides.setupStep ?? 1)));
  const provisioning = useProvisioning();
  // 取得するモデル (選択中。セットアップでは話す言語の推奨) の名前・容量を出すため
  const { models } = useModels();
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
            {t.setup.windowTitle}
          </span>
          <span className="flex-1" />
          <span className="w-[52px]" />
        </header>
        <div className="flex gap-1 px-8 pt-4" aria-label={t.setup.progress(step, STEPS)}>
          {Array.from({ length: STEPS }, (_, i) => (
            <span
              key={i}
              className={cn("h-[3px] flex-1 rounded-[2px]", i < step ? "bg-action-primary" : "bg-progress-pending")}
            />
          ))}
        </div>
        {step === 1 && <WelcomeStep provisioning={provisioning} models={models} onNext={next} />}
        {step === 2 && <PermissionsStep onBack={back} onNext={next} />}
        {step === 3 && <DownloadStep provisioning={provisioning} models={models} onNext={next} />}
        {step === 4 && <InputModeStep onBack={back} onNext={next} />}
        {step === 5 && <TestStep onBack={back} onNext={next} />}
        {step === 6 && <DoneStep provisioning={provisioning} />}
      </div>
    </WindowFrame>
  );
}

function StepBody({
  hero = false,
  dense = false,
  tight = false,
  children,
}: {
  hero?: boolean;
  dense?: boolean;
  /** 上の余白を詰める (内容の多いステップ) */
  tight?: boolean;
  children: ReactNode;
}) {
  return (
    // 文言が長い場合にフッターへ重ならないよう、はみ出した分はスクロールさせる
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-y-auto px-8 pb-3",
        dense ? "gap-3" : "gap-3.5",
        hero ? "pt-10" : tight ? "pt-5" : "pt-7",
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

/* ---------- 1. ようこそ ---------- */

/** 取得するモデル。選択中 (セットアップ中は Rust が話す言語の推奨にそろえる) が無ければ推奨 */
function setupModel(models: ModelInfo[] | null): ModelInfo | null {
  return models?.find((m) => m.selected) ?? models?.find((m) => m.recommended) ?? null;
}

/** 選択肢 (各言語の自称) */
const LANGUAGE_OPTIONS = LOCALES.map((l) => ({ value: l, label: LOCALE_AUTONYMS[l] }));

function WelcomeStep({
  provisioning,
  models,
  onNext,
}: {
  provisioning: ProvisioningStatus | null;
  models: ModelInfo[] | null;
  onNext: () => void;
}) {
  const { locale, t } = useI18n();
  const w = t.setup.welcome;
  const [settings, update, errors] = useSettings();
  // 容量は取得するモデルの固定値 (list_models の sizeBytes)。ファイル一覧の取得前でも出せる。取れない場合は容量を出さない
  const size = setupModel(models)?.sizeBytes;
  // 話す言語の変更で取得するモデル (選択) が変わるのは、導入が実行中でも完了済みでもなく、モデルの取得を始めていない時だけ
  // (Rust の Provisioning::if_model_not_started と同じ条件)。それ以外は選ばせず理由を出す
  const lock = speechLock(provisioning);
  return (
    <>
      {/* 言語の選択を足した分、ロゴは見出しと横に並べて縦に詰める (ウィンドウの高さは固定) */}
      <StepBody dense tight>
        <div className="flex items-center gap-3.5">
          <AppLogo size={44} />
          <Title large>{w.title}</Title>
        </div>
        <p className="m-0 text-md leading-[1.6] text-fg-body">{w.lead}</p>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm text-fg-muted">
          <li className="flex items-start gap-2">
            <ShieldCheck size={16} className="mt-0.5 flex-none" aria-hidden />
            {w.privacy}
          </li>
          <li data-testid="welcome-download" className="flex items-start gap-2">
            <Download size={16} className="mt-0.5 flex-none" aria-hidden />
            {size ? w.downloadWithSize(formatBytes(size, locale)) : w.download}
          </li>
          <li className="flex items-start gap-2">
            <Clock size={16} className="mt-0.5 flex-none" aria-hidden />
            {w.duration}
          </li>
        </ul>
        <div className="grid grid-cols-2 gap-3">
          <LanguageField label={w.uiLanguage}>
            <Select
              aria-label={w.uiLanguage}
              data-testid="ui-language"
              options={LANGUAGE_OPTIONS}
              // 初期は解決済みの表示言語 (uiLanguage は system のまま)。選ぶとその言語で保存し、すぐに切り替わる
              value={locale}
              disabled={!settings}
              onValueChange={(v) => {
                if (isLocale(v)) update({ uiLanguage: v });
              }}
            />
          </LanguageField>
          <LanguageField label={w.speechLanguage} help={w.speechLanguageHelp}>
            <Select
              aria-label={w.speechLanguage}
              data-testid="speech-language"
              options={LANGUAGE_OPTIONS}
              value={settings?.speechLanguage ?? ""}
              // 導入の状態の取得前も変えさせない (Rust がモデルの選択を変えるか分からないため)
              disabled={!settings || !provisioning || lock != null}
              onValueChange={(v) => {
                if (isLocale(v)) update({ speechLanguage: v });
              }}
            />
          </LanguageField>
        </div>
        {lock ? (
          <p data-testid="speech-language-locked" data-reason={lock} className="m-0 text-xs leading-[1.5] text-fg-muted">
            {lock === "running" ? w.speechLanguageLockedRunning : w.speechLanguageLocked}
          </p>
        ) : null}
        {errors.uiLanguage || errors.speechLanguage ? (
          <p role="alert" className="m-0 text-xs leading-[1.5] text-fg-danger">
            {errors.uiLanguage ?? errors.speechLanguage}
          </p>
        ) : null}
      </StepBody>
      <StepFooter>
        <Button variant="primary" onClick={onNext}>
          {w.start}
        </Button>
      </StepFooter>
    </>
  );
}

/**
 * 話す言語を変えられない理由。running: 導入の実行中 (実行環境の準備中を含む)。started: モデルの取得を始めた・完了した。
 */
function speechLock(p: ProvisioningStatus | null): "running" | "started" | null {
  if (!p) return null;
  if (p.items.some((i) => i.id === "model" && i.state !== "pending") || p.stage === "done") return "started";
  if (p.stage === "runtime" || p.stage === "model" || p.stage === "verify") return "running";
  return null;
}

function LanguageField({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-sm leading-[1.4] font-medium text-fg-body">
        {label}
        {help ? <HelpTip content={help} /> : null}
      </span>
      {children}
    </div>
  );
}

/* ---------- 2. 権限 ---------- */

function PermissionBadge({ granted }: { granted: boolean }) {
  const { t } = useI18n();
  return granted ? (
    <Badge tone="success" dot>
      {t.common.granted}
    </Badge>
  ) : (
    <Badge tone="warning" dot>
      {t.common.notGranted}
    </Badge>
  );
}

function PermissionsStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { t } = useI18n();
  const ps = t.setup.permissions;
  // システム設定での変更は通知されないことがあるため 1 秒ごとに再取得する
  const [perms, setPerms] = usePermissions(1000);
  const granted = isPermissionsGranted(perms);
  return (
    <>
      <StepBody>
        <Title>{ps.title}</Title>
        <p className="m-0 text-sm leading-[1.6] text-fg-muted">{ps.lead}</p>
        <div className="flex flex-col rounded-lg border border-line-default">
          <div className="flex items-center gap-3 border-b border-line-subtle px-4 py-3.5">
            <Mic size={20} className="flex-none text-fg-muted" aria-hidden />
            <div className="flex flex-1 flex-col gap-0.5">
              <span className="text-md leading-[1.4] font-medium">{ps.microphone}</span>
              <span className="text-xs leading-[1.4] text-fg-muted">{ps.microphoneSub}</span>
            </div>
            <PermissionBadge granted={perms?.microphone === "granted"} />
          </div>
          <div className="flex items-center gap-3 px-4 py-3.5">
            <Keyboard size={20} className="flex-none text-fg-muted" aria-hidden />
            <div className="flex flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-md leading-[1.4] font-medium">
                {ps.accessibility}
                <HelpTip content={ps.accessibilityHelp} />
              </span>
              <span className="text-xs leading-[1.4] text-fg-muted">{ps.accessibilitySub}</span>
            </div>
            <PermissionBadge granted={!!perms?.accessibility} />
          </div>
        </div>
        {perms && !granted ? <PermissionGuide perms={perms} onChange={setPerms} /> : null}
      </StepBody>
      <StepFooter align="between">
        <Button variant="ghost" onClick={onBack}>
          {t.common.back}
        </Button>
        <Button variant="primary" disabled={!granted} onClick={onNext}>
          {t.common.next}
        </Button>
      </StepFooter>
    </>
  );
}

/** 未許可の権限への案内。先に未許可のマイク、次にアクセシビリティの順で 1 つずつ出す */
function PermissionGuide({ perms, onChange }: { perms: Permissions; onChange: (p: Permissions) => void }) {
  const { t } = useI18n();
  const ps = t.setup.permissions;
  let text: string;
  let button: ReactNode;
  if (perms.microphone === "not_determined") {
    text = ps.guideMicNotDetermined;
    button = (
      <Button size="sm" onClick={() => commands.requestMicrophone().then(onChange, () => {})}>
        {t.common.allow}
      </Button>
    );
  } else if (perms.microphone === "denied") {
    text = ps.guideMicDenied;
    button = (
      <Button size="sm" iconRight={ExternalLink} onClick={() => runCommand(commands.openSystemSettings("microphone"))}>
        {t.common.openSystemSettings}
      </Button>
    );
  } else {
    text = ps.guideAccessibility;
    button = (
      <Button size="sm" iconRight={ExternalLink} onClick={() => runCommand(commands.openSystemSettings("accessibility"))}>
        {t.common.openSystemSettings}
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

/** 項目の名前。model は取得するモデルの表示名 (Rust の ModelInfo.name。一覧の取得前は汎用の名前) */
function itemLabel(id: ProvisioningItem["id"], model: ModelInfo | null, t: Messages): string {
  const d = t.setup.download;
  if (id === "runtime") return d.runtime;
  if (id === "model") return model?.name ?? d.modelFallback;
  return d.verify;
}

function runningText(id: ProvisioningItem["id"], t: Messages): string {
  const d = t.setup.download;
  return id === "runtime" ? d.runningRuntime : id === "model" ? d.runningModel : d.runningVerify;
}

function isRunning(p: ProvisioningStatus): boolean {
  return p.stage === "runtime" || p.stage === "model" || p.stage === "verify";
}

/** 全体の行の右側。バイト数は model のみ (runtime・verify は大きさが分からない) */
function summaryText(p: ProvisioningStatus, locale: Locale, t: Messages): string {
  const d = t.setup.download;
  const parts: string[] = [];
  if (p.bytesTotal != null) parts.push(`${formatBytes(p.bytesDone, locale)} / ${formatBytes(p.bytesTotal, locale)}`);
  if (p.stage === "runtime" || (p.stage === "idle" && p.bytesTotal == null)) parts.push(d.preparingRuntime);
  if (p.stage === "model") parts.push(p.etaSeconds != null ? formatEta(p.etaSeconds, t) : d.etaCalculating);
  if (p.stage === "verify") parts.push(d.verifying);
  if (p.stage === "paused") parts.push(d.paused);
  return parts.join(t.common.separator);
}

function itemRight(item: ProvisioningItem, stage: ProvisioningStatus["stage"], locale: Locale, t: Messages): string {
  const d = t.setup.download;
  if (item.state === "pending") return d.pending;
  if (item.state === "done") return item.bytesTotal != null ? formatBytes(item.bytesTotal, locale) : d.done;
  if (item.bytesTotal != null) return formatBytesPair(item.bytesDone, item.bytesTotal, locale);
  if (stage === "paused") return d.paused;
  if (stage === "error") return d.failed;
  return runningText(item.id, t);
}

function DownloadStep({
  provisioning: p,
  models,
  onNext,
}: {
  provisioning: ProvisioningStatus | null;
  models: ModelInfo[] | null;
  onNext: () => void;
}) {
  const { locale, t } = useI18n();
  const d = t.setup.download;
  const model = setupModel(models);
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
        <Title>{d.titlePending}</Title>
        <p className="m-0 text-sm text-fg-muted">{d.checkingStatus}</p>
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
          {done ? d.titleDone : paused ? d.titlePaused : failed ? d.titleFailed : d.titleRunning}
        </Title>
        <div className="flex flex-col gap-2">
          <div className="flex justify-between gap-3 text-sm">
            <span>{d.overall}</span>
            <span className="tabular text-fg-muted">{summaryText(p, locale, t)}</span>
          </div>
          <div
            className="h-1.5 rounded-[3px] bg-meter-track"
            role="progressbar"
            aria-label={d.overallProgress}
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
                <span className="flex-1">{itemLabel(item.id, model, t)}</span>
                <span className={cn(item.state !== "pending" && "tabular text-fg-muted")}>
                  {itemRight(item, p.stage, locale, t)}
                </span>
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
              {p.error ?? d.failedFallback}
              {resumeBytes > 0 ? d.resumeFrom(formatBytes(resumeBytes, locale)) : ""}
            </span>
            <Button size="sm" iconLeft={RotateCw} onClick={start}>
              {t.common.retry}
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
            {t.common.resume}
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
            {t.common.pause}
          </Button>
        )}
        {/* 動作確認まで済んでから (stage=done) 次へ進める。complete_setup はその後でしか呼ばない */}
        <Button variant="primary" disabled={!done} onClick={onNext}>
          {t.common.next}
        </Button>
      </StepFooter>
    </>
  );
}

/* ---------- 4. 入力モード ---------- */

function InputModeStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { t } = useI18n();
  const [settings, update, errors] = useSettings();
  // 未知の値 (Rust が足した等) は既定として扱う
  const mode: InputMode = settings?.inputMode === "oneShot" ? "oneShot" : "continuous";
  const current = t.inputMode[mode];
  return (
    <>
      <StepBody dense>
        <Title>{t.setup.inputMode.title}</Title>
        <div className="flex gap-3">
          <InputModeRadio
            className="w-[264px] flex-none"
            value={settings?.inputMode}
            disabled={!settings}
            onChange={(m) => update({ inputMode: m })}
          />
          {/* 選んでいるモードが向いている場面。選び替えると入れ替わる */}
          <div data-testid="input-mode-use-cases" className="flex min-w-0 flex-1 flex-col gap-2 rounded-lg bg-surface-muted px-3.5 py-3">
            <span className="text-xs font-semibold text-fg-muted">{t.setup.inputMode.useCases}</span>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm leading-[1.5] text-fg-body">
              {current.useCases.map((u) => (
                <li key={u} className="flex items-start gap-1.5">
                  <Check size={14} className="mt-[3px] flex-none text-fg-success" aria-hidden />
                  {u}
                </li>
              ))}
            </ul>
          </div>
        </div>
        {errors.inputMode ? (
          <p role="alert" className="m-0 text-xs leading-[1.5] text-fg-danger">
            {errors.inputMode}
          </p>
        ) : null}
        <div className="flex items-start gap-3">
          <span className="flex h-[30px] flex-none items-center gap-1.5 text-sm font-medium">
            {t.shortcut.label}
            <HelpTip content={t.shortcut.help} />
          </span>
          <ShortcutRecorder
            shortcut={settings?.shortcut}
            disabled={!settings}
            onChange={(shortcut) => update({ shortcut })}
            error={errors.shortcut}
            hint={t.inputMode.shortcutHint[mode]}
          />
        </div>
      </StepBody>
      <StepFooter align="between">
        <Button variant="ghost" onClick={onBack}>
          {t.common.back}
        </Button>
        <Button variant="primary" onClick={onNext}>
          {t.common.next}
        </Button>
      </StepFooter>
    </>
  );
}

/* ---------- 5. 動作テスト ---------- */

/** 入力レベル。約15Hz で更新されるのでここだけが購読・再描画する。長さはパネルと同じく平滑化する */
function SetupLevelBar({ on }: { on: boolean }) {
  const { level } = useAudioLevel();
  const barRef = useLevelEnvelope<HTMLDivElement>(on ? level : 0);
  return (
    <div className="h-1 flex-1 rounded-[2px] bg-meter-track-strong">
      <div ref={barRef} className="h-1 rounded-[2px] bg-green-500" />
    </div>
  );
}

/** 動作テストの案内。1回ずつ聞き取るではショートカットで始めてもらい、自動でオフになることを先に伝える */
function TestInstruction({ mode, shortcut, sample }: { mode: InputMode; shortcut: string | null; sample: string }) {
  const { t } = useI18n();
  const ts = t.setup.test;
  const keys = shortcut ? <ShortcutKeys shortcut={shortcut} className="mx-0.5 align-[1px]" /> : null;
  if (mode === "oneShot") return keys ? ts.oneShotWithKeys(keys, sample) : ts.oneShotNoKeys(sample);
  return keys ? ts.continuousWithKeys(keys, sample) : ts.continuousNoKeys(sample);
}

function TestStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const { t } = useI18n();
  const ts = t.setup.test;
  const status = useAppStatus();
  const [settings] = useSettings();
  const [recognized, setRecognized] = useState(false);
  // 音声コマンドは欄にキー操作として届くため、何を送ったかをバッジで示す
  const [commandsSent, setCommandsSent] = useState<{ id: number; text: string; key: string }[]>([]);
  const on = status != null && ["listening", "speaking", "finalizing", "done"].includes(status.phase);

  // セットアップ完了前は panel が出ていないため、このステップに入った時に出す (パネルでオンにしてもらう)
  useEffect(() => {
    runCommand(commands.showPanel());
  }, []);

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
        <Title>{ts.title}</Title>
        <p data-testid="test-instruction" className="m-0 text-sm leading-[1.6] text-fg-muted">
          {settings ? (
            <TestInstruction
              mode={settings.inputMode}
              shortcut={settings.shortcut}
              // 例文は話す言語で出す
              sample={SAMPLE_PHRASES[settings.speechLanguage] ?? SAMPLE_PHRASES.ja}
            />
          ) : null}
        </p>
        <div className="flex h-8 flex-none items-center gap-2.5 rounded-md bg-surface-muted px-3">
          <AudioLines size={16} className="flex-none text-blue-500" aria-hidden />
          <SetupLevelBar on={on} />
          <span className="text-xs text-fg-muted">{ts.inputLevel}</span>
        </div>
        {/* 実際の入力先。前面のこの欄に Rust から貼り付けられる */}
        <div className="flex min-h-[88px] flex-col rounded-md border border-line-default px-3 py-2 transition-control focus-within:border-line-focus focus-within:shadow-[var(--focus-ring)]">
          <textarea
            autoFocus
            aria-label={ts.field}
            rows={2}
            className="w-full flex-1 resize-none border-0 bg-transparent p-0 pt-1 text-md leading-[1.6] text-fg-strong outline-none focus-visible:outline-none"
          />
          {commandsSent.length > 0 ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-1 text-md leading-[1.6] text-fg-strong">
              {commandsSent.map((c) => (
                <span key={c.id} className="inline-flex items-center gap-2">
                  {c.text}
                  <Badge tone="violet">{ts.sentKey(c.key)}</Badge>
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {recognized ? (
          <div className="flex items-center gap-1.5 text-xs text-fg-success">
            <CircleCheck size={14} aria-hidden />
            {ts.recognized}
          </div>
        ) : null}
      </StepBody>
      <StepFooter align="between">
        <Button variant="ghost" onClick={onBack}>
          {t.common.back}
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onNext}>
            {t.common.skip}
          </Button>
          <Button variant="primary" onClick={onNext}>
            {t.common.next}
          </Button>
        </div>
      </StepFooter>
    </>
  );
}

/* ---------- 6. 完了 ---------- */

function DoneStep({ provisioning }: { provisioning: ProvisioningStatus | null }) {
  const { t } = useI18n();
  const ds = t.setup.done;
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
        <Title large>{ds.title}</Title>
        <p className="m-0 text-md leading-[1.6]">{ds.lead}</p>
        <div className="flex items-center gap-2.5 rounded-lg border border-line-default px-3.5 py-3 text-sm">
          <span data-testid="done-toggle-hint" className="flex-1 leading-[1.6]">
            {settings?.shortcut && settings.inputMode === "oneShot"
              ? ds.hintOneShot(<ShortcutKeys shortcut={settings.shortcut} className="mx-0.5 align-[1px]" />)
              : settings?.shortcut
                ? ds.hintWithKeys(<ShortcutKeys shortcut={settings.shortcut} className="mx-0.5 align-[1px]" />)
                : ds.hintNoKeys}
          </span>
        </div>
        <Switch
          label={ds.launchAtLogin}
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
          {t.common.close}
        </Button>
      </StepFooter>
    </>
  );
}
