/*
 * OS ごとの出し分け (docs/plans/windows-plan.md §4.3)。
 * OS はビルドで決まり起動中に変わらないため、起動時に get_app_info で 1 回だけ取り、Context で配る (main.tsx)。
 * OS で変わる文言・キー表記は辞書 (src/i18n) に PerOs で持ち、機能の有無はここの OS_FEATURES で持つ。
 * コンポーネントには `platform === …` の分岐を書かず、os() (useI18n) か useOsFeatures() を使う
 */
import { createContext, useContext } from "react";
import { commands, type AppInfo } from "./ipc";

export type Platform = AppInfo["platform"];

/** OS ごとに値を持つ (辞書の文言・キー表記)。ja.ts で書けば型で en にも両方の OS が要求される */
export type PerOs<T> = { macos: T; windows: T };

export const PLATFORMS = ["macos", "windows"] as const satisfies readonly Platform[];

export function isPlatform(value: unknown): value is Platform {
  return (PLATFORMS as readonly unknown[]).includes(value);
}

/**
 * 起動時の OS。取れない・未知の値 (platform を返さない版の Rust を含む) は macos とする
 * (Windows 対応より前は Mac だけだったため、Mac の表示を変えない)
 */
export async function loadPlatform(): Promise<Platform> {
  try {
    const info = await commands.getAppInfo();
    return isPlatform(info.platform) ? info.platform : "macos";
  } catch (e) {
    console.warn(e);
    return "macos";
  }
}

export const PlatformContext = createContext<Platform>("macos");

/** 起動時に取った OS */
export function usePlatform(): Platform {
  return useContext(PlatformContext);
}

/** PerOs から OS の値を取る */
export function pickOs<T>(value: PerOs<T>, platform: Platform): T {
  return value[platform];
}

/** OS ごとの機能の有無。OS で出し分ける UI はこのフラグで分ける */
export type OsFeatures = {
  /** アクセシビリティの権限がある (Windows にはない。行・案内・エラーを出さない) */
  accessibility: boolean;
  /** GPU の判定と CPU 実行の同意 (docs/architecture.md「GPU の判定と CPU 実行の同意」) を扱う */
  gpuCheck: boolean;
  /** タイトルバーに信号機ボタンがあり、その分の余白を取る */
  trafficLights: boolean;
  /** 入力しないアプリに識別子 (Windows は実行ファイル名) を補助表示する。Mac の bundleId は利用者に意味がないため出さない */
  appIdHint: boolean;
  /**
   * セットアップの完了画面で、ショートカットを登録できていなければ案内する。Windows は他アプリと衝突すると
   * 登録 (RegisterHotKey) に失敗して分かるが、Mac は衝突しても登録に成功するため検出できない
   */
  shortcutConflictNotice: boolean;
};

const OS_FEATURES: PerOs<OsFeatures> = {
  macos: { accessibility: true, gpuCheck: false, trafficLights: true, appIdHint: false, shortcutConflictNotice: false },
  windows: { accessibility: false, gpuCheck: true, trafficLights: false, appIdHint: true, shortcutConflictNotice: true },
};

export function osFeatures(platform: Platform): OsFeatures {
  return OS_FEATURES[platform];
}

export function useOsFeatures(): OsFeatures {
  return osFeatures(usePlatform());
}
