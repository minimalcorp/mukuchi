import { useEffect, useState } from "react";
import { AppWindow, AudioLines, Plus, X } from "lucide-react";
import { Select } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAudioLevel } from "@/lib/audio-level";
import { LevelMeter } from "@/components/app/level-meter";
import { InputModeRadio } from "@/components/app/input-mode-options";
import { ShortcutRecorder } from "@/components/app/shortcut-recorder";
import { errorMessage, useDebouncedCommit } from "@/lib/hooks";
import {
  commands,
  subscribeEvents,
  type AppStatus,
  type AudioDevice,
  type AutoSubmitKey,
  type KeyCombo,
  type RunningApp,
} from "@/lib/ipc";
import { formatKeyCombo, formatSeconds } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/context";
import { Card, FieldError, FieldHeading, Row, TitleWithSub, type SectionProps } from "./common";

/** 送信キーの表示用。modEnter は macOS の主修飾キー (⌘)。実際に送るキーは Rust が OS ごとに決める */
const AUTO_SUBMIT_KEYS: Record<AutoSubmitKey, KeyCombo> = {
  enter: { key: "enter", modifiers: [] },
  modEnter: { key: "enter", modifiers: ["cmd"] },
};

const ON_PHASES: AppStatus["phase"][] = ["listening", "speaking", "finalizing", "done"];

/**
 * 感度から求めた入力レベル上のしきい値 (0..1)。audio-level が届く前・オフの間に使う。
 * Rust の VadParams::from_settings の floor_db と floor_level (-60〜-10 dB を 0〜1) に合わせる
 */
function thresholdFromSensitivity(sensitivity: number): number {
  const floorDb = -45 + (60 - sensitivity) * 0.25;
  return Math.min(1, Math.max(0, (floorDb + 60) / 50));
}

/** マイク一覧。表示時・フォーカス時・接続の変化 (input-devices-changed) で取り直す */
function useInputDevices(): { devices: AudioDevice[] | null; error: string | null } {
  const [devices, setDevices] = useState<AudioDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      commands.listInputDevices().then(
        (d) => {
          if (disposed) return;
          setDevices(d);
          setError(null);
        },
        (e: unknown) => {
          if (!disposed) setError(errorMessage(e));
        },
      );
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    // 購読してから取得する (取得中の接続変化を取りこぼさない)
    const unsubscribe = subscribeEvents(
      {
        "input-devices-changed": (list) => {
          // 変化後の一覧が届く。形が違う (旧版) 場合は取り直す
          if (Array.isArray(list)) {
            setDevices(list);
            setError(null);
          } else refresh();
        },
      },
      refresh,
    );
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      disposed = true;
      unsubscribe();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return { devices, error };
}

export function VoiceSection({ settings, update, errors, status }: SectionProps & { status: AppStatus | null }) {
  const { locale, t } = useI18n();
  const v = t.settings.voice;
  const { devices, error: devicesError } = useInputDevices();
  const sensitivity = useDebouncedCommit(settings.vadSensitivity, (v) => update({ vadSensitivity: v }));
  // スライダーは 0.1 秒刻み (3〜30) で扱う
  const silence = useDebouncedCommit(Math.round(settings.silenceMs / 100), (v) => update({ silenceMs: v * 100 }));

  const list = devices ?? [];
  const defaultDevice = list.find((d) => d.isDefault);
  const selected = settings.inputDeviceId;
  const options = [
    { value: "", label: defaultDevice ? v.systemDefaultWith(defaultDevice.name) : v.systemDefault },
    ...list.map((d) => ({ value: d.id, label: d.name })),
  ];
  // 選んだマイクが外れている間も選択を残す (Rust はつながるまで既定のマイクを使う想定)。一覧の取得前は出さない
  if (selected && devices && !list.some((d) => d.id === selected)) {
    options.push({ value: selected, label: v.disconnected });
  }
  const isOn = status != null && ON_PHASES.includes(status.phase);

  return (
    <>
      <div className="flex flex-col gap-2">
        <FieldHeading
          label={t.inputMode.groupLabel}
          help={v.inputModeHelp}
        />
        <InputModeRadio
          value={settings.inputMode}
          onChange={(m) => update({ inputMode: m })}
        />
        <FieldError message={errors.inputMode} />
      </div>
      <div className="flex flex-col gap-2">
        <FieldHeading label={t.shortcut.label} help={t.shortcut.help} />
        <ShortcutRecorder
          shortcut={settings.shortcut}
          onChange={(shortcut) => update({ shortcut })}
          error={errors.shortcut}
          hint={t.inputMode.shortcutHint[settings.inputMode]}
        />
      </div>
      <AutoSubmit settings={settings} update={update} errors={errors} />
      <div className="flex flex-col gap-1.5">
        <Select
          label={v.microphone}
          options={options}
          value={selected ?? ""}
          onValueChange={(v) => update({ inputDeviceId: v === "" ? null : v })}
        />
        <FieldError message={errors.inputDeviceId ?? devicesError} />
      </div>
      <InputLevel
        isOn={isOn}
        sensitivity={sensitivity.value}
        editing={sensitivity.value !== settings.vadSensitivity}
      />
      <div className="flex flex-col gap-2">
        <FieldHeading
          label={v.sensitivity}
          help={v.sensitivityHelp}
          value={sensitivity.value}
        />
        <Slider
          aria-label={v.sensitivity}
          min={0}
          max={100}
          value={sensitivity.value}
          onChange={(e) => sensitivity.change(Number(e.target.value))}
          onPointerUp={sensitivity.flush}
          onKeyUp={sensitivity.flush}
          onBlur={sensitivity.flush}
        />
        <div className="flex justify-between text-2xs text-fg-subtle">
          <span>{v.low}</span>
          <span>{v.high}</span>
        </div>
        <FieldError message={errors.vadSensitivity} />
      </div>
      <div className="flex flex-col gap-2">
        <FieldHeading
          label={v.silence}
          help={v.silenceHelp}
          value={formatSeconds(silence.value / 10, locale, t)}
        />
        <Slider
          aria-label={v.silence}
          min={3}
          max={30}
          value={silence.value}
          onChange={(e) => silence.change(Number(e.target.value))}
          onPointerUp={silence.flush}
          onKeyUp={silence.flush}
          onBlur={silence.flush}
        />
        <div className="flex justify-between text-2xs text-fg-subtle">
          <span>{formatSeconds(0.3, locale, t)}</span>
          <span>{formatSeconds(3, locale, t)}</span>
        </div>
        <FieldError message={errors.silenceMs} />
      </div>
      <ExcludedApps settings={settings} update={update} errors={errors} />
    </>
  );
}

/** 自動送信 (docs/architecture.md「決定事項」の自動送信)。OFF の間も送信キーは見せ、選べないようにする (音声コマンドの対応表と同じ扱い) */
function AutoSubmit({ settings, update, errors }: SectionProps) {
  const { t } = useI18n();
  const v = t.settings.voice;
  const keyOptions = (Object.keys(AUTO_SUBMIT_KEYS) as AutoSubmitKey[]).map((k) => ({
    value: k,
    label: formatKeyCombo(AUTO_SUBMIT_KEYS[k]),
  }));
  return (
    <div className="flex flex-col gap-2">
      <Card>
        <Row>
          <TitleWithSub title={v.autoSubmit} sub={v.autoSubmitSub} />
          <Switch
            aria-label={v.autoSubmit}
            checked={settings.autoSubmit}
            onCheckedChange={(on) => update({ autoSubmit: on })}
          />
        </Row>
        <Row last>
          <span className={cn("flex-1 text-sm", !settings.autoSubmit && "text-fg-muted")}>{v.autoSubmitKey}</span>
          <Select
            aria-label={v.autoSubmitKey}
            data-testid="auto-submit-key"
            className="w-[160px] flex-none"
            options={keyOptions}
            value={settings.autoSubmitKey}
            disabled={!settings.autoSubmit}
            onValueChange={(k) => update({ autoSubmitKey: k === "modEnter" ? "modEnter" : "enter" })}
          />
        </Row>
      </Card>
      <FieldError message={errors.autoSubmit ?? errors.autoSubmitKey} />
    </div>
  );
}

/**
 * 入力レベル。オンの間だけ Rust から届く。
 * トラックの塗り分け位置 (しきい値) は audio-level の threshold を使い、届く前・オフの間・感度の操作中 (保存前) は感度から求めた位置に置く
 */
function InputLevel({ isOn, sensitivity, editing }: { isOn: boolean; sensitivity: number; editing: boolean }) {
  const { t } = useI18n();
  const { level, threshold, received } = useAudioLevel();
  const split = isOn && received && !editing ? threshold : thresholdFromSensitivity(sensitivity);
  const shown = isOn ? level : 0;
  return (
    <div className="-mt-2 flex h-8 items-center gap-2.5 rounded-md bg-surface-muted px-3" data-testid="input-level">
      <AudioLines size={14} className="flex-none text-fg-muted" aria-hidden />
      {/* パネルと同じく、表示中の塗り分け位置を超えたら青にする (感度の操作中も見た目の境目と一致させる) */}
      <LevelMeter testId="input-level-meter" level={shown} threshold={split} active={isOn && shown >= split} />
      <span className="text-xs text-fg-muted">{t.settings.voice.inputLevel}</span>
    </div>
  );
}

/** 入力しないアプリ (デザイン 07-A) */
function ExcludedApps({ settings, update, errors }: SectionProps) {
  const { t } = useI18n();
  const v = t.settings.voice;
  const [running, setRunning] = useState<RunningApp[] | null>(null);
  const [runningError, setRunningError] = useState<string | null>(null);
  const excluded = settings.excludedApps;
  const candidates = (running ?? []).filter((a) => !excluded.some((e) => e.bundleId === a.bundleId));

  return (
    <div className="flex flex-col gap-2">
      <FieldHeading
        label={v.excludedApps}
        help={v.excludedAppsHelp}
      />
      <Card className="text-sm">
        {excluded.map((app) => (
          <div key={app.bundleId} className="flex items-center gap-2.5 border-b border-line-subtle px-3.5 py-2.5">
            <AppWindow size={16} className="flex-none text-fg-muted" aria-hidden />
            <span className="flex-1">{app.name}</span>
            <IconButton
              icon={X}
              label={v.removeApp(app.name)}
              size="sm"
              onClick={() => update({ excludedApps: excluded.filter((e) => e.bundleId !== app.bundleId) })}
            />
          </div>
        ))}
        {excluded.length === 0 ? (
          <div className="border-b border-line-subtle px-3.5 py-2.5 text-fg-muted">{v.noApps}</div>
        ) : null}
        <div className="px-2.5 py-2">
          <DropdownMenu
            onOpenChange={(open) => {
              if (!open) return;
              // 開くたびに取り直す (起動中のアプリは変わるため)
              setRunning(null);
              setRunningError(null);
              commands.listRunningApps().then(setRunning, (e: unknown) => {
                setRunning([]);
                setRunningError(errorMessage(e));
              });
            }}
          >
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" iconLeft={Plus}>
                {v.addApp}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>{v.runningApps}</DropdownMenuLabel>
              {running === null ? <DropdownMenuLabel>{v.loadingApps}</DropdownMenuLabel> : null}
              {runningError ? <DropdownMenuLabel className="text-fg-danger">{runningError}</DropdownMenuLabel> : null}
              {running !== null && !runningError && candidates.length === 0 ? (
                <DropdownMenuLabel>{v.noCandidates}</DropdownMenuLabel>
              ) : null}
              {candidates.map((app) => (
                <DropdownMenuItem key={app.bundleId} onSelect={() => update({ excludedApps: [...excluded, app] })}>
                  <AppWindow size={16} className="flex-none text-fg-muted" aria-hidden />
                  {app.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </Card>
      <FieldError message={errors.excludedApps} />
    </div>
  );
}
