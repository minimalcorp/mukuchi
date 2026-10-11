import type { ReactNode } from "react";
import { ExternalLink, Keyboard, Mic } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { commands, runCommand, type Permissions } from "@/lib/ipc";
import { useOsFeatures } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/context";
import { Card, TitleWithSub } from "./common";

export function PermissionsSection({
  permissions: p,
  onChange,
}: {
  permissions: Permissions | null;
  onChange: (p: Permissions) => void;
}) {
  const { t, os } = useI18n();
  const ps = t.settings.permissions;
  // Windows にアクセシビリティの権限はない (マイクの行だけ出す)
  const { accessibility } = useOsFeatures();
  if (!p) return null;
  const mic = p.microphone;
  return (
    <Card>
      <div className={cn("flex flex-col gap-2.5 px-4 py-3.5", accessibility && "border-b border-line-subtle")}>
        <div className="flex items-center gap-3">
          <Mic size={20} className="flex-none text-fg-muted" aria-hidden />
          <TitleWithSub title={ps.microphone} sub={ps.microphoneSub} />
          {mic === "granted" ? (
            <Badge tone="success" dot>
              {t.common.granted}
            </Badge>
          ) : (
            <Badge tone={mic === "denied" ? "danger" : "warning"} dot>
              {t.common.notGranted}
            </Badge>
          )}
        </div>
        {mic === "not_determined" ? (
          <Guide
            text={ps.micNotDetermined}
            action={
              <Button size="sm" onClick={() => commands.requestMicrophone().then(onChange, () => {})}>
                {t.common.allow}
              </Button>
            }
          />
        ) : mic === "denied" ? (
          <Guide
            text={os(ps.micDenied)}
            action={<OpenSettingsButton pane="microphone" />}
          />
        ) : null}
      </div>
      {accessibility ? (
        <div className="flex flex-col gap-2.5 px-4 py-3.5">
          <div className="flex items-center gap-3">
            <Keyboard size={20} className="flex-none text-fg-muted" aria-hidden />
            <TitleWithSub title={ps.accessibility} sub={ps.accessibilitySub} />
            {p.accessibility ? (
              <Badge tone="success" dot>
                {t.common.granted}
              </Badge>
            ) : (
              <Badge tone="danger" dot>
                {t.common.notGranted}
              </Badge>
            )}
          </div>
          {!p.accessibility ? (
            <Guide
              text={ps.accessibilityDenied}
              action={<OpenSettingsButton pane="accessibility" />}
            />
          ) : null}
        </div>
      ) : null}
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
  const { t, os } = useI18n();
  return (
    <Button size="sm" iconRight={ExternalLink} onClick={() => runCommand(commands.openSystemSettings(pane))}>
      {os(t.common.openSystemSettings)}
    </Button>
  );
}
