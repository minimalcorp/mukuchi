import type { ReactNode } from "react";
import { ExternalLink, Keyboard, Mic } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { commands, type Permissions } from "@/lib/ipc";
import { Card, TitleWithSub } from "./common";

export function PermissionsSection({
  permissions: p,
  onChange,
}: {
  permissions: Permissions | null;
  onChange: (p: Permissions) => void;
}) {
  if (!p) return null;
  const mic = p.microphone;
  return (
    <Card>
      <div className="flex flex-col gap-2.5 border-b border-line-subtle px-4 py-3.5">
        <div className="flex items-center gap-3">
          <Mic size={20} className="flex-none text-fg-muted" aria-hidden />
          <TitleWithSub title="マイク" sub="発話を聞き取るために使います" />
          {mic === "granted" ? (
            <Badge tone="success" dot>
              許可済み
            </Badge>
          ) : (
            <Badge tone={mic === "denied" ? "danger" : "warning"} dot>
              未許可
            </Badge>
          )}
        </div>
        {mic === "not_determined" ? (
          <Guide
            text="マイクの使用がまだ許可されていません。許可すると音声入力を使えます。"
            action={
              <Button size="sm" onClick={() => commands.requestMicrophone().then(onChange, () => {})}>
                許可する
              </Button>
            }
          />
        ) : mic === "denied" ? (
          <Guide
            text="許可されていないため、音声を聞き取れません。システム設定 > プライバシーとセキュリティ > マイク で mukuchi をオンにしてください。"
            action={<OpenSettingsButton pane="microphone" />}
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-2.5 px-4 py-3.5">
        <div className="flex items-center gap-3">
          <Keyboard size={20} className="flex-none text-fg-muted" aria-hidden />
          <TitleWithSub title="アクセシビリティ" sub="文字とキー操作の入力に使います" />
          {p.accessibility ? (
            <Badge tone="success" dot>
              許可済み
            </Badge>
          ) : (
            <Badge tone="danger" dot>
              未許可
            </Badge>
          )}
        </div>
        {!p.accessibility ? (
          <Guide
            text="許可されていないため、文字起こしはできますが入力できません。システム設定 > プライバシーとセキュリティ > アクセシビリティ で mukuchi をオンにしてください。"
            action={<OpenSettingsButton pane="accessibility" />}
          />
        ) : null}
      </div>
    </Card>
  );
}

function Guide({ text, action }: { text: string; action: ReactNode }) {
  return (
    <div className="ml-8 flex items-center gap-2.5 rounded-md bg-tone-warning-bg px-3 py-2.5 text-xs text-tone-warning-fg">
      <span className="flex-1 leading-[1.5]">{text}</span>
      {action}
    </div>
  );
}

function OpenSettingsButton({ pane }: { pane: "microphone" | "accessibility" }) {
  return (
    <Button size="sm" iconRight={ExternalLink} onClick={() => void commands.openSystemSettings(pane)}>
      システム設定を開く
    </Button>
  );
}
