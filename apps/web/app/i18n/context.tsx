import { createContext, useContext, type ReactNode } from "react";
import type { Messages } from "./ja";
import type { Locale } from "./locales";

interface I18n {
  locale: Locale;
  m: Messages;
}

const I18nContext = createContext<I18n | null>(null);

/**
 * ページの言語と辞書を配る。辞書はルートごとに import して渡す
 * (各言語のページの JS に、ほかの言語の辞書を含めないため)
 */
export function I18nProvider({
  locale,
  messages,
  children,
}: {
  locale: Locale;
  messages: Messages;
  children: ReactNode;
}) {
  return <I18nContext value={{ locale, m: messages }}>{children}</I18nContext>;
}

export function useI18n(): I18n {
  const v = useContext(I18nContext);
  if (!v) throw new Error("I18nProvider の外で useI18n を呼んだ");
  return v;
}
