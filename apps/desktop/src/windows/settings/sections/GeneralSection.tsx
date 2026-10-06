import { Switch } from "@/components/ui/switch";
import { Select } from "@/components/ui/select";
import { LaunchAtLoginError } from "@/components/app/launch-at-login-error";
import { useI18n } from "@/i18n/context";
import { isLocale, LOCALE_AUTONYMS, LOCALES } from "@/i18n/locales";
import { Card, FieldError, Row, TitleWithSub, type SectionProps } from "./common";

export function GeneralSection({ settings, update, errors }: SectionProps) {
  const { t } = useI18n();
  // 言語は各言語の自称で並べる (どの表示言語でも自分の言語を見つけられるように)。「システムに合わせる」だけ表示言語
  const languageOptions = [
    { value: "system", label: t.settings.general.system },
    ...LOCALES.map((l) => ({ value: l, label: LOCALE_AUTONYMS[l] })),
  ];
  return (
    <>
      <section className="flex flex-col gap-2.5">
        <h2 className="m-0 text-xs font-semibold text-fg-muted">{t.settings.general.language}</h2>
        <Card>
          <Row last>
            <TitleWithSub title={t.settings.general.uiLanguage} sub={t.settings.general.uiLanguageSub} />
            <Select
              aria-label={t.settings.general.uiLanguage}
              data-testid="ui-language"
              className="w-[200px] flex-none"
              options={languageOptions}
              value={settings.uiLanguage}
              onValueChange={(v) => update({ uiLanguage: v === "system" || !isLocale(v) ? "system" : v })}
            />
          </Row>
        </Card>
        <FieldError message={errors.uiLanguage} />
      </section>
      <section className="flex flex-col gap-2.5">
        <h2 className="m-0 text-xs font-semibold text-fg-muted">{t.settings.general.behavior}</h2>
        <Card>
          <div className="flex items-center px-3.5 py-3">
            <span className="flex-1 text-sm">{t.settings.general.launchAtLogin}</span>
            <Switch
              aria-label={t.settings.general.launchAtLogin}
              checked={settings.launchAtLogin}
              onCheckedChange={(v) => update({ launchAtLogin: v })}
            />
          </div>
        </Card>
        <LaunchAtLoginError message={errors.launchAtLogin} />
      </section>
      <section className="flex flex-col gap-2.5">
        <h2 className="m-0 text-xs font-semibold text-fg-muted">{t.settings.general.panel}</h2>
        <Card>
          <Row last>
            <TitleWithSub title={t.settings.general.compact} sub={t.settings.general.compactSub} />
            <Switch
              aria-label={t.settings.general.compact}
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
