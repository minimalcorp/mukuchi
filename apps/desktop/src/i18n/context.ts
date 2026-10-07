import { createContext, useContext } from "react";
import type { Locale } from "@/lib/ipc";
import { ja, type Messages } from "./ja";
import { en } from "./en";

export type { Messages };

export const MESSAGES: Record<Locale, Messages> = { ja, en };

export type I18n = { locale: Locale; t: Messages };

export const I18nContext = createContext<I18n | null>(null);

/** 表示言語と辞書。I18nProvider (provider.tsx) の中で使う */
export function useI18n(): I18n {
  const v = useContext(I18nContext);
  if (!v) throw new Error("useI18n は I18nProvider の中で使う");
  return v;
}
