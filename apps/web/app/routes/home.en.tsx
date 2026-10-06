import type { Route } from "./+types/home.en";
import { HomePage } from "@/components/home-page";
import { I18nProvider } from "@/i18n/context";
import { en } from "@/i18n/en";
import type { LocaleHandle } from "@/i18n/locales";
import { pageMeta } from "@/lib/meta";

export const handle: LocaleHandle = { locale: "en" };

export function meta(): Route.MetaDescriptors {
  return pageMeta("en", en);
}

export default function HomeEn() {
  return (
    <I18nProvider locale="en" messages={en}>
      <HomePage />
    </I18nProvider>
  );
}
