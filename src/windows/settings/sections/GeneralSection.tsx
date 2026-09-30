import { Switch } from "@/components/ui/switch";
import { LaunchAtLoginError } from "@/components/app/launch-at-login-error";
import { Card, FieldError, Row, TitleWithSub, type SectionProps } from "./common";

export function GeneralSection({ settings, update, errors }: SectionProps) {
  return (
    <>
      <section className="flex flex-col gap-2.5">
        <h2 className="m-0 text-xs font-semibold text-fg-muted">動作</h2>
        <Card>
          <div className="flex items-center px-3.5 py-3">
            <span className="flex-1 text-sm">ログイン時に起動</span>
            <Switch
              aria-label="ログイン時に起動"
              checked={settings.launchAtLogin}
              onCheckedChange={(v) => update({ launchAtLogin: v })}
            />
          </div>
        </Card>
        <LaunchAtLoginError message={errors.launchAtLogin} />
      </section>
      <section className="flex flex-col gap-2.5">
        <h2 className="m-0 text-xs font-semibold text-fg-muted">パネル</h2>
        <Card>
          <Row last>
            <TitleWithSub
              title="コンパクト表示"
              sub="音声入力パネルをマイクのボタンだけにします。右クリックメニューからも切り替えられます"
            />
            <Switch
              aria-label="コンパクト表示"
              checked={settings.panelStyle === "compact"}
              onCheckedChange={(v) => update({ panelStyle: v ? "compact" : "full" })}
            />
          </Row>
        </Card>
        <FieldError message={errors.panelStyle} />
      </section>
    </>
  );
}
