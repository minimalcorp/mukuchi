import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { formatKeyCombo, KEY_LABELS, MODIFIER_LABELS, MODIFIER_ORDER } from "@/lib/format";
import type { KeyCombo, KeyName, VoiceCommand } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { Card, TitleWithSub, type SectionProps } from "./common";

const GRID = "grid grid-cols-[1fr_130px_64px] gap-3";

export function CommandsSection({ settings, update }: SectionProps) {
  // 編集中のコマンド。id が空なら追加
  const [editing, setEditing] = useState<VoiceCommand | null>(null);
  const list = settings.voiceCommands;

  const save = (cmd: VoiceCommand) => {
    const exists = list.some((c) => c.id === cmd.id);
    update({ voiceCommands: exists ? list.map((c) => (c.id === cmd.id ? cmd : c)) : [...list, cmd] });
    setEditing(null);
  };

  return (
    <>
      <Card className="flex-row items-center gap-3 px-3.5 py-3">
        <TitleWithSub
          title="音声コマンドを使う"
          sub="発話全体が登録した言い方と一致したときだけ、キー操作として送ります。"
        />
        <Switch
          aria-label="音声コマンドを使う"
          checked={settings.voiceCommandsEnabled}
          onCheckedChange={(v) => update({ voiceCommandsEnabled: v })}
        />
      </Card>
      <Card className={cn("text-sm", !settings.voiceCommandsEnabled && "opacity-50")}>
        <div
          className={cn(
            GRID,
            "rounded-t-lg border-b border-line-default bg-surface-muted px-3.5 py-2 text-xs text-fg-muted",
          )}
        >
          <span>言い方</span>
          <span>送るキー</span>
          <span />
        </div>
        {list.map((cmd) => (
          <div key={cmd.id} className={cn(GRID, "items-center border-b border-line-subtle px-3.5 py-2.5")}>
            <div className="flex flex-wrap gap-1">
              {cmd.phrases.map((w) => (
                <span key={w} className="rounded-sm bg-surface-chip px-2 py-0.5 text-xs text-fg-strong">
                  {w}
                </span>
              ))}
            </div>
            <span className="justify-self-start rounded-sm border border-line-strong px-2 py-0.5 font-mono text-xs">
              {formatKeyCombo(cmd.key)}
            </span>
            <div className="flex justify-end gap-0.5">
              <IconButton icon={Pencil} label="編集" size="sm" onClick={() => setEditing(cmd)} />
              <IconButton
                icon={Trash2}
                label="削除"
                size="sm"
                onClick={() => update({ voiceCommands: list.filter((c) => c.id !== cmd.id) })}
              />
            </div>
          </div>
        ))}
        <div className="px-2.5 py-2">
          <Button
            variant="ghost"
            size="sm"
            iconLeft={Plus}
            onClick={() => setEditing({ id: "", phrases: [], key: { key: "enter", modifiers: [] } })}
          >
            コマンドを追加
          </Button>
        </div>
      </Card>
      <p className="m-0 text-xs leading-[1.6] text-fg-muted">
        「確定してください」のように前後に言葉があると、通常の文字として入力されます。
      </p>
      <CommandDialog command={editing} onCancel={() => setEditing(null)} onSave={save} />
    </>
  );
}

function CommandDialog({
  command,
  onCancel,
  onSave,
}: {
  command: VoiceCommand | null;
  onCancel: () => void;
  onSave: (c: VoiceCommand) => void;
}) {
  return (
    <Dialog open={command != null} onOpenChange={(open) => !open && onCancel()}>
      {/* key で開くたびにフォームを初期化する */}
      {command ? <CommandForm key={command.id || "new"} command={command} onCancel={onCancel} onSave={onSave} /> : null}
    </Dialog>
  );
}

function CommandForm({
  command,
  onCancel,
  onSave,
}: {
  command: VoiceCommand;
  onCancel: () => void;
  onSave: (c: VoiceCommand) => void;
}) {
  const [phrases, setPhrases] = useState(command.phrases.join("、"));
  const [key, setKey] = useState<KeyCombo>(command.key);
  const parsed = phrases
    .split(/[、,，\n]/)
    .map((p) => p.trim())
    .filter(Boolean);
  const isNew = command.id === "";

  const toggleModifier = (m: KeyCombo["modifiers"][number]) =>
    setKey((k) => ({
      ...k,
      modifiers: k.modifiers.includes(m) ? k.modifiers.filter((x) => x !== m) : [...k.modifiers, m],
    }));

  return (
    <DialogContent>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (parsed.length === 0) return;
          onSave({ id: command.id || crypto.randomUUID(), phrases: parsed, key });
        }}
      >
        <div className="flex flex-col gap-2 px-5 pt-5">
          <DialogTitle className="m-0 text-lg leading-[1.4] font-semibold text-fg-strong">
            {isNew ? "コマンドを追加" : "コマンドを編集"}
          </DialogTitle>
          <DialogDescription className="m-0 text-sm text-fg-muted">
            言い方は読点で区切って複数登録できます。
          </DialogDescription>
        </div>
        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="command-phrases" className="text-sm leading-[1.4] font-medium">
              言い方
            </label>
            <Input
              id="command-phrases"
              autoFocus
              placeholder="確定、エンター"
              value={phrases}
              onChange={(e) => setPhrases(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm leading-[1.4] font-medium">送るキー</span>
            <div className="flex items-center gap-2">
              <div className="flex gap-1" role="group" aria-label="修飾キー">
                {MODIFIER_ORDER.map((m) => {
                  const on = key.modifiers.includes(m);
                  return (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleModifier(m)}
                      className={cn(
                        "press h-[34px] cursor-pointer rounded-md border px-2.5 font-mono text-xs transition-control",
                        on
                          ? "border-action-primary bg-surface-selected text-fg-selected"
                          : "border-line-strong bg-surface-card text-fg-body hover:bg-surface-hover",
                      )}
                    >
                      {MODIFIER_LABELS[m]}
                    </button>
                  );
                })}
              </div>
              <span className="text-fg-muted">+</span>
              <Select
                aria-label="キー"
                className="flex-1"
                options={(Object.keys(KEY_LABELS) as KeyName[]).map((k) => ({ value: k, label: KEY_LABELS[k] }))}
                value={key.key}
                onValueChange={(v) => setKey((k) => ({ ...k, key: v as KeyName }))}
              />
            </div>
            <span className="text-xs text-fg-muted">
              送るキー: <span className="font-mono">{formatKeyCombo(key)}</span>
            </span>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 pb-5">
          <Button onClick={onCancel}>キャンセル</Button>
          <Button type="submit" variant="primary" disabled={parsed.length === 0}>
            保存
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
