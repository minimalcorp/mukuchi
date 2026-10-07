import type { Route } from "./+types/home";
import { HomePage } from "@/components/home-page";
import { I18nProvider } from "@/i18n/context";
import { ja } from "@/i18n/ja";
import type { LocaleHandle } from "@/i18n/locales";
import { pageMeta } from "@/lib/meta";

export const handle: LocaleHandle = { locale: "ja" };

export function meta(): Route.MetaDescriptors {
  return pageMeta("ja", ja);
}

export default function Home() {
  return (
    <I18nProvider locale="ja" messages={ja}>
      <HomePage />
    </I18nProvider>
  );
}
