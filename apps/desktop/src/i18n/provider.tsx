/*
 * 表示言語の Context。locale は Rust の get_locale と locale-changed から取る
 * (WebView の navigator.language は .app の宣言するローカライズに左右されるため使わない)。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { commands, subscribeWithInitial, type Locale } from "@/lib/ipc";
import { I18nContext, MESSAGES } from "./context";

/** get_locale を取れなかった時・未知の値の時。Rust の解決で対応表に当たらない時の既定 (en) に合わせる */
const FALLBACK_LOCALE: Locale = "en";

/**
 * 子は locale が決まってから描く (違う言語で描いてから切り替わるのを避ける)。
 * get_locale に失敗した場合は FALLBACK_LOCALE で描く
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale | null>(null);
  useEffect(
    () =>
      subscribeWithInitial(
        "locale-changed",
        () =>
          commands.getLocale().catch((e: unknown) => {
            setLocale((l) => l ?? FALLBACK_LOCALE);
            throw e;
          }),
        // 未知の値 (Rust が言語を足した等) は辞書がないため既定にする
        (l) => setLocale(Object.hasOwn(MESSAGES, l) ? l : FALLBACK_LOCALE),
      ),
    [],
  );
  useEffect(() => {
    if (locale) document.documentElement.lang = locale;
  }, [locale]);
  const value = useMemo(() => (locale ? { locale, t: MESSAGES[locale] } : null), [locale]);
  if (!value) return null;
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
