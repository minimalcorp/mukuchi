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
import { commands, type AppStatus, type AudioDevice, type RunningApp } from "@/lib/ipc";
import { Card, FieldHeading, type SectionProps } from "./common";

const ON_PHASES: AppStatus["phase"][] = ["listening", "speaking", "finalizing", "done"];

export function VoiceSection({ settings, update, status }: SectionProps & { status: AppStatus | null }) {
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  useEffect(() => {
    commands.listInputDevices().then(setDevices, () => {});
  }, []);

  const defaultDevice = devices.find((d) => d.isDefault);
  const options = [
    { value: "", label: defaultDevice ? `システムの既定（${defaultDevice.name}）` : "システムの既定" },
    ...devices.map((d) => ({ value: d.id, label: d.name })),
  ];
  const isOn = status != null && ON_PHASES.includes(status.phase);

  return (
    <>
      <Select
        label="マイク"
        options={options}
        value={settings.inputDeviceId ?? ""}
        onValueChange={(v) => update({ inputDeviceId: v === "" ? null : v })}
      />
      <InputLevel isOn={isOn} sensitivity={settings.vadSensitivity} />
      <div className="flex flex-col gap-2">
        <FieldHeading
          label="発話検出の感度"
          help="高くすると小さな声も拾います。周囲がうるさい場合は下げてください。入力レベルの縦線が検出のしきい値です"
          value={settings.vadSensitivity}
        />
        <Slider
          aria-label="発話検出の感度"
          min={0}
          max={100}
          value={settings.vadSensitivity}
          onChange={(e) => update({ vadSensitivity: Number(e.target.value) })}
        />
        <div className="flex justify-between text-2xs text-fg-subtle">
          <span>低い</span>
          <span>高い</span>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <FieldHeading
          label="話し終わりと判定するまでの無音"
          help="短くすると早く入力されますが、息継ぎで文が途切れやすくなります"
          value={`${(settings.silenceMs / 1000).toFixed(1)} 秒`}
        />
        <Slider
          aria-label="話し終わりと判定するまでの無音"
          min={3}
          max={30}
          value={Math.round(settings.silenceMs / 100)}
          onChange={(e) => update({ silenceMs: Number(e.target.value) * 100 })}
        />
        <div className="flex justify-between text-2xs text-fg-subtle">
          <span>0.3 秒</span>
          <span>3.0 秒</span>
        </div>
      </div>
      <ExcludedApps settings={settings} update={update} />
    </>
  );
}

/** 入力レベル。オンの間だけ Rust から届く。しきい値の縦線は、届く前は感度から求めた位置に置く */
function InputLevel({ isOn, sensitivity }: { isOn: boolean; sensitivity: number }) {
  const { level, threshold, received } = useAudioLevel();
  const line = isOn && received ? threshold : (100 - sensitivity) / 100;
  return (
    <div className="-mt-2 flex h-8 items-center gap-2.5 rounded-md bg-surface-muted px-3" data-testid="input-level">
      <AudioLines size={14} className="flex-none text-fg-muted" aria-hidden />
      <div className="relative h-1 flex-1 rounded-[2px] bg-meter-track-strong">
        <div className="h-1 rounded-[2px] bg-green-500" style={{ width: `${(isOn ? level : 0) * 100}%` }} />
        <span className="absolute -top-1 h-3 w-0.5 bg-meter-threshold" style={{ left: `${line * 100}%` }} aria-hidden />
      </div>
      <span className="text-xs text-fg-muted">入力レベル</span>
    </div>
  );
}

/** 入力しないアプリ (デザイン 07-A) */
function ExcludedApps({ settings, update }: SectionProps) {
  const [running, setRunning] = useState<RunningApp[] | null>(null);
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
              if (open) commands.listRunningApps().then(setRunning, () => setRunning([]));
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
              {running !== null && candidates.length === 0 ? (
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
    </div>
  );
}
