import { GA_MEASUREMENT_ID, SITE_URL } from "./site";

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

/** gtag を読み込むか。dev (Playwright を含む) では読み込まない */
export const ANALYTICS_ENABLED = import.meta.env.PROD;

/**
 * gtag の初期化 (<head> のインライン script)。本番のビルドでも vite preview・本番以外の SST ステージで
 * 計測を汚さないよう、SITE_URL のホストで開いた時だけ config する (config しなければ何も送られない)
 */
export const GTAG_INIT_SCRIPT = `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}
if(location.hostname===${JSON.stringify(new URL(SITE_URL).hostname)}){gtag("js",new Date());gtag("config",${JSON.stringify(GA_MEASUREMENT_ID)});}`;

/** GA4 のイベントを送る。gtag が無い (dev・広告ブロッカー) 場合は何もしない */
export function track(name: string, params: Record<string, string>) {
  window.gtag?.("event", name, params);
}

export type CtaLocation = "header" | "hero" | "final" | "footer";
