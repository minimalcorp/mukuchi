import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { formatKeyCombo, KEY_LABELS, MODIFIER_ORDER, modifierLabels } from "@/lib/format";
import type { KeyCombo, KeyName, Locale, VoiceCommand } from "@/lib/ipc";
import { splitPhrases, validatePhrases } from "@/lib/voice-command";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/context";
import { COMMAND_PHRASE_EXAMPLES, COMMAND_SENTENCE_EXAMPLES } from "@/i18n/speech";
import { Card, FieldError, TitleWithSub, type SectionProps } from "./common";

const GRID = "grid grid-cols-[1fr_130px_64px] gap-3";

export function CommandsSection({ settings, update, errors }: SectionProps) {
  const { t, platform } = useI18n();
  const c = t.settings.commands;
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
          title={c.enable}
          sub={c.enableSub}
        />
        <Switch
          aria-label={c.enable}
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
          <span>{c.phrases}</span>
          <span>{c.key}</span>
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
              {formatKeyCombo(cmd.key, platform)}
            </span>
            <div className="flex justify-end gap-0.5">
              <IconButton icon={Pencil} label={c.edit} size="sm" onClick={() => setEditing(cmd)} />
              <IconButton
                icon={Trash2}
                label={c.delete}
                size="sm"
                onClick={() => update({ voiceCommands: list.filter((x) => x.id !== cmd.id) })}
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
            {c.add}
          </Button>
        </div>
      </Card>
      <FieldError message={errors.voiceCommandsEnabled ?? errors.voiceCommands} />
      <p className="m-0 text-xs leading-[1.6] text-fg-muted">
        {c.note(COMMAND_SENTENCE_EXAMPLES[settings.speechLanguage] ?? COMMAND_SENTENCE_EXAMPLES.ja)}
      </p>
      <CommandDialog
        command={editing}
        others={list.filter((x) => x.id !== editing?.id)}
        speechLanguage={settings.speechLanguage}
        onCancel={() => setEditing(null)}
        onSave={save}
      />
    </>
  );
}

function CommandDialog({
  command,
  others,
  speechLanguage,
  onCancel,
  onSave,
}: {
  command: VoiceCommand | null;
  others: VoiceCommand[];
  speechLanguage: Locale;
  onCancel: () => void;
  onSave: (c: VoiceCommand) => void;
}) {
  return (
    <Dialog open={command != null} onOpenChange={(open) => !open && onCancel()}>
      {/* key で開くたびにフォームを初期化する */}
      {command ? (
        <CommandForm
          key={command.id || "new"}
          command={command}
          others={others}
          speechLanguage={speechLanguage}
          onCancel={onCancel}
          onSave={onSave}
        />
      ) : null}
    </Dialog>
  );
}

function CommandForm({
  command,
  others,
  speechLanguage,
  onCancel,
  onSave,
}: {
  command: VoiceCommand;
  /** 編集中以外のコマンド (言い方の重複を調べる。他ウィンドウでの変更も反映される) */
  others: VoiceCommand[];
  /** 言い方の例 (placeholder) を話す言語で出す */
  speechLanguage: Locale;
  onCancel: () => void;
  onSave: (c: VoiceCommand) => void;
}) {
  const { t, platform } = useI18n();
  const c = t.settings.commands;
  const [phrases, setPhrases] = useState(command.phrases.join(c.phraseJoiner));
  const [key, setKey] = useState<KeyCombo>(command.key);
  const parsed = splitPhrases(phrases);
  const error = validatePhrases(parsed, others, (x) => formatKeyCombo(x.key, platform), c.validation);
  // 空欄は保存ボタンを無効にするだけで、エラーとしては出さない (開いた直後に赤字を出さない)
  const shownError = parsed.length === 0 ? null : error;
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
          if (error) return;
          onSave({ id: command.id || crypto.randomUUID(), phrases: parsed, key });
        }}
      >
        <div className="flex flex-col gap-2 px-5 pt-5">
          <DialogTitle className="m-0 text-lg leading-[1.4] font-semibold text-fg-strong">
            {isNew ? c.addTitle : c.editTitle}
          </DialogTitle>
          <DialogDescription className="m-0 text-sm text-fg-muted">
            {c.dialogDescription}
          </DialogDescription>
        </div>
        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="command-phrases" className="text-sm leading-[1.4] font-medium">
              {c.phrases}
            </label>
            <Input
              id="command-phrases"
              autoFocus
              placeholder={(COMMAND_PHRASE_EXAMPLES[speechLanguage] ?? COMMAND_PHRASE_EXAMPLES.ja).join(c.phraseJoiner)}
              value={phrases}
              aria-invalid={shownError ? true : undefined}
              aria-describedby={shownError ? "command-phrases-error" : undefined}
              onChange={(e) => setPhrases(e.target.value)}
            />
            <div id="command-phrases-error">
              <FieldError message={shownError} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-sm leading-[1.4] font-medium">{c.key}</span>
            <div className="flex items-center gap-2">
              <div className="flex gap-1" role="group" aria-label={c.modifiers}>
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
                      {modifierLabels(platform)[m]}
                    </button>
                  );
                })}
              </div>
              <span className="text-fg-muted">+</span>
              <Select
                aria-label={c.keyName}
                className="flex-1"
                options={(Object.keys(KEY_LABELS) as KeyName[]).map((k) => ({ value: k, label: KEY_LABELS[k] }))}
                value={key.key}
                onValueChange={(v) => setKey((k) => ({ ...k, key: v as KeyName }))}
              />
            </div>
            <span className="text-xs text-fg-muted">
              {c.keyPreview} <span className="font-mono">{formatKeyCombo(key, platform)}</span>
            </span>
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 pb-5">
          <Button onClick={onCancel}>{t.common.cancel}</Button>
          <Button type="submit" variant="primary" disabled={error != null}>
            {t.common.save}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
