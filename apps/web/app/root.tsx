import { Links, Meta, Outlet, Scripts, ScrollRestoration, useMatches } from "react-router";
// フォントは同梱する (外部の CDN に問い合わせない)。和文は unicode-range で分割され、使う文字の分だけ読み込まれる
import "@fontsource/ibm-plex-sans-jp/400.css";
import "@fontsource/ibm-plex-sans-jp/500.css";
import "@fontsource/ibm-plex-sans-jp/600.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/600.css";
import "./globals.css";
import { ANALYTICS_ENABLED, GTAG_INIT_SCRIPT } from "./lib/analytics";
import { GA_MEASUREMENT_ID } from "./lib/site";
import { isLocale, type Locale } from "./i18n/locales";

/** 表示中のページの言語 (ルートの handle.locale)。404 など言語のないページは日本語 (`/` と同じ) */
function usePageLocale(): Locale {
  const matches = useMatches();
  for (let i = matches.length - 1; i >= 0; i--) {
    const locale = (matches[i].handle as { locale?: unknown } | undefined)?.locale;
    if (isLocale(locale)) return locale;
  }
  return "ja";
}

export function Layout({ children }: { children: React.ReactNode }) {
  // 事前生成の時点で決まるので、HTML の lang は各言語のページで正しく出る
  const locale = usePageLocale();
  return (
    <html lang={locale}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#ffffff" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <Meta />
        <Links />
        {/* 事前生成の HTML に含め、ハイドレーションを待たずに計測を始める */}
        {ANALYTICS_ENABLED && (
          <>
            <script
              async
              src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
            />
            <script dangerouslySetInnerHTML={{ __html: GTAG_INIT_SCRIPT }} />
          </>
        )}
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function Root() {
  return <Outlet />;
}
