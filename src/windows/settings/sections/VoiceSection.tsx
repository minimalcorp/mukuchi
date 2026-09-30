import { useEffect, useState } from "react";
import { AppWindow, AudioLines, Plus, X } from "lucide-react";
import { Select } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
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
import { errorMessage, useDebouncedCommit } from "@/lib/hooks";
import { commands, subscribeEvents, type AppStatus, type AudioDevice, type RunningApp } from "@/lib/ipc";
import { Card, FieldError, FieldHeading, type SectionProps } from "./common";

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
  const { devices, error: devicesError } = useInputDevices();
  const sensitivity = useDebouncedCommit(settings.vadSensitivity, (v) => update({ vadSensitivity: v }));
  // スライダーは 0.1 秒刻み (3〜30) で扱う
  const silence = useDebouncedCommit(Math.round(settings.silenceMs / 100), (v) => update({ silenceMs: v * 100 }));

  const list = devices ?? [];
  const defaultDevice = list.find((d) => d.isDefault);
  const selected = settings.inputDeviceId;
  const options = [
    { value: "", label: defaultDevice ? `システムの既定（${defaultDevice.name}）` : "システムの既定" },
    ...list.map((d) => ({ value: d.id, label: d.name })),
  ];
  // 選んだマイクが外れている間も選択を残す (Rust はつながるまで既定のマイクを使う想定)。一覧の取得前は出さない
  if (selected && devices && !list.some((d) => d.id === selected)) {
    options.push({ value: selected, label: "選択中のマイク（接続されていません）" });
  }
  const isOn = status != null && ON_PHASES.includes(status.phase);

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Select
          label="マイク"
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
          label="発話検出の感度"
          help="高くすると小さな声も拾います。周囲がうるさい場合は下げてください。入力レベルのトラックが薄い青に変わる位置が検出のしきい値です"
          value={sensitivity.value}
        />
        <Slider
          aria-label="発話検出の感度"
          min={0}
          max={100}
          value={sensitivity.value}
          onChange={(e) => sensitivity.change(Number(e.target.value))}
          onPointerUp={sensitivity.flush}
          onKeyUp={sensitivity.flush}
          onBlur={sensitivity.flush}
        />
        <div className="flex justify-between text-2xs text-fg-subtle">
          <span>低い</span>
          <span>高い</span>
        </div>
        <FieldError message={errors.vadSensitivity} />
      </div>
      <div className="flex flex-col gap-2">
        <FieldHeading
          label="話し終わりと判定するまでの無音"
          help="短くすると早く入力されますが、息継ぎで文が途切れやすくなります"
          value={`${(silence.value / 10).toFixed(1)} 秒`}
        />
        <Slider
          aria-label="話し終わりと判定するまでの無音"
          min={3}
          max={30}
          value={silence.value}
          onChange={(e) => silence.change(Number(e.target.value))}
          onPointerUp={silence.flush}
          onKeyUp={silence.flush}
          onBlur={silence.flush}
        />
        <div className="flex justify-between text-2xs text-fg-subtle">
          <span>0.3 秒</span>
          <span>3.0 秒</span>
        </div>
        <FieldError message={errors.silenceMs} />
      </div>
      <ExcludedApps settings={settings} update={update} errors={errors} />
    </>
  );
}

/**
 * 入力レベル。オンの間だけ Rust から届く。
 * トラックの塗り分け位置 (しきい値) は audio-level の threshold を使い、届く前・オフの間・感度の操作中 (保存前) は感度から求めた位置に置く
 */
function InputLevel({ isOn, sensitivity, editing }: { isOn: boolean; sensitivity: number; editing: boolean }) {
  const { level, threshold, received } = useAudioLevel();
  const split = isOn && received && !editing ? threshold : thresholdFromSensitivity(sensitivity);
  const shown = isOn ? level : 0;
  return (
    <div className="-mt-2 flex h-8 items-center gap-2.5 rounded-md bg-surface-muted px-3" data-testid="input-level">
      <AudioLines size={14} className="flex-none text-fg-muted" aria-hidden />
      {/* パネルと同じく、表示中の塗り分け位置を超えたら青にする (感度の操作中も見た目の境目と一致させる) */}
      <LevelMeter testId="input-level-meter" level={shown} threshold={split} active={isOn && shown >= split} />
      <span className="text-xs text-fg-muted">入力レベル</span>
    </div>
  );
}

/** 入力しないアプリ (デザイン 07-A) */
function ExcludedApps({ settings, update, errors }: SectionProps) {
  const [running, setRunning] = useState<RunningApp[] | null>(null);
  const [runningError, setRunningError] = useState<string | null>(null);
  const excluded = settings.excludedApps;
  const candidates = (running ?? []).filter((a) => !excluded.some((e) => e.bundleId === a.bundleId));

  return (
    <div className="flex flex-col gap-2">
      <FieldHeading
        label="入力しないアプリ"
        help="パスワード管理アプリやターミナルなど、誤入力を避けたいアプリを登録します。前面にある間は入力せず、パネルに「このアプリには入力しません」と表示します"
      />
      <Card className="text-sm">
        {excluded.map((app) => (
          <div key={app.bundleId} className="flex items-center gap-2.5 border-b border-line-subtle px-3.5 py-2.5">
            <AppWindow size={16} className="flex-none text-fg-muted" aria-hidden />
            <span className="flex-1">{app.name}</span>
            <IconButton
              icon={X}
              label={`${app.name} を削除`}
              size="sm"
              onClick={() => update({ excludedApps: excluded.filter((e) => e.bundleId !== app.bundleId) })}
            />
          </div>
        ))}
        {excluded.length === 0 ? (
          <div className="border-b border-line-subtle px-3.5 py-2.5 text-fg-muted">登録したアプリはありません</div>
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
                アプリを追加
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>起動中のアプリ</DropdownMenuLabel>
              {running === null ? <DropdownMenuLabel>読み込んでいます…</DropdownMenuLabel> : null}
              {runningError ? <DropdownMenuLabel className="text-fg-danger">{runningError}</DropdownMenuLabel> : null}
              {running !== null && !runningError && candidates.length === 0 ? (
                <DropdownMenuLabel>追加できるアプリはありません</DropdownMenuLabel>
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
