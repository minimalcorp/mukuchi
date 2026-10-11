import type { MetaDescriptor } from "react-router";
import type { Messages } from "../i18n/ja";
import {
  DEFAULT_LOCALE_FOR_OTHERS,
  LOCALES,
  OG_LOCALES,
  pageUrl,
  type Locale,
} from "../i18n/locales";
import { pickAvail } from "./content";
import { SITE_NAME, SITE_URL, WINDOWS_AVAILABLE } from "./site";

/** 各言語のページの meta。言語ごとのページを hreflang・og:locale:alternate で相互に示す */
export function pageMeta(locale: Locale, m: Messages): MetaDescriptor[] {
  const url = pageUrl(locale);
  // 事前生成の HTML に入るので、公開状況は開発時の上書き (?windowsAvailable=) ではなく定数で決める
  const description = pickAvail(m.meta.description, WINDOWS_AVAILABLE);
  return [
    { title: m.meta.title },
    { name: "description", content: description },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: SITE_NAME },
    { property: "og:locale", content: OG_LOCALES[locale] },
    ...LOCALES.filter((l) => l !== locale).map((l) => ({
      property: "og:locale:alternate",
      content: OG_LOCALES[l],
    })),
    { property: "og:url", content: url },
    { property: "og:title", content: m.meta.title },
    { property: "og:description", content: description },
    { property: "og:image", content: `${SITE_URL}${m.meta.ogImage}` },
    // 寸法を明示すると、初回共有時にクローラーが画像を取得し終える前でもプレビューを描画できる
    { property: "og:image:type", content: "image/jpeg" },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:image:alt", content: m.meta.ogImageAlt },
    { name: "twitter:card", content: "summary_large_image" },
    { tagName: "link", rel: "canonical", href: url },
    ...LOCALES.map((l) => ({ tagName: "link", rel: "alternate", hrefLang: l, href: pageUrl(l) })),
    {
      tagName: "link",
      rel: "alternate",
      hrefLang: "x-default",
      href: pageUrl(DEFAULT_LOCALE_FOR_OTHERS),
    },
  ];
}
