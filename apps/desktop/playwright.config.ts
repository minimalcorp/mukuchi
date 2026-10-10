import { defineConfig, devices, type Project } from "@playwright/test";
import process from "node:process";
import type { AppLocaleOptions } from "./e2e/fixtures";

// モック (src/mock) で各ウィンドウ・状態を開いて確認する。
// Tauri の WebView (WKWebView) に近い WebKit で実行する。
// モックの OS の言語 (表示言語) は e2e/fixtures.ts の appLocale で切り替える。
//
// テストはタグ (e2e/fixtures.ts) で project に振り分ける:
// - ja: 全テスト (実時間を測る @timing と撮影だけの @screenshot-only を除く)。並列
// - en: 英語の表示・はみ出しと言語で分岐する所 (@i18n) だけ。並列
// - ja-timing / en-timing: @timing を、並列の project が終わってから 1 worker で回す (並列の負荷でフレームが間引かれないように)
// - win-ja / win-en: Windows の表示 (@windows) を Chromium で回す (Windows の WebView2 は Chromium)。Mac の project は @windows を回さない
// pnpm screenshots (SCREENSHOTS=1) は撮影するテスト (@screenshot・@screenshot-only) だけを ja・en で回す
// (Windows は e2e/screenshots/windows/<言語>/ に撮る)
//
// どの OS の project を回すかは MUKUCHI_E2E_PLATFORM (macos | windows | all)。既定は実行するホストの OS
// (Mac の CI・手元は webkit だけ、Windows の CI・手元は chromium だけを入れれば回る)
const SCREENSHOTS = Boolean(process.env.SCREENSHOTS);
const E2E_PLATFORM = process.env.MUKUCHI_E2E_PLATFORM ?? (process.platform === "win32" ? "windows" : "macos");
const RUN_MACOS = E2E_PLATFORM === "macos" || E2E_PLATFORM === "all";
const RUN_WINDOWS = E2E_PLATFORM === "windows" || E2E_PLATFORM === "all";

const ja = { browserName: "webkit" as const, appLocale: "ja" as const };
const en = { browserName: "webkit" as const, appLocale: "en" as const };
// 表示の倍率は Windows でよく使う 150%
const chromium = { ...devices["Desktop Chrome"], browserName: "chromium" as const, deviceScaleFactor: 1.5 };
const winJa = { ...chromium, appLocale: "ja" as const, appPlatform: "windows" as const };
const winEn = { ...chromium, appLocale: "en" as const, appPlatform: "windows" as const };

const testProjects: Project<AppLocaleOptions>[] = [
  ...(RUN_MACOS
    ? [
        { name: "ja", use: ja, grepInvert: /@timing|@screenshot-only|@windows/ },
        { name: "en", use: en, grep: /@i18n/, grepInvert: /@timing|@screenshot-only|@windows/ },
        { name: "ja-timing", use: ja, grep: /@timing/, grepInvert: /@windows/, workers: 1, dependencies: ["ja", "en"] },
        // @timing かつ @i18n (タグの順序によらない)
        {
          name: "en-timing",
          use: en,
          grep: /^(?=.*@timing)(?=.*@i18n)/,
          grepInvert: /@windows/,
          workers: 1,
          dependencies: ["ja-timing"],
        },
      ]
    : []),
  ...(RUN_WINDOWS
    ? [
        { name: "win-ja", use: winJa, grep: /@windows/, grepInvert: /@screenshot-only/ },
        { name: "win-en", use: winEn, grep: /@windows/, grepInvert: /@screenshot-only/ },
      ]
    : []),
];

const screenshotProjects: Project<AppLocaleOptions>[] = [
  ...(RUN_MACOS
    ? [
        { name: "ja", use: ja, grep: /@screenshot/, grepInvert: /@windows/ },
        { name: "en", use: en, grep: /@screenshot/, grepInvert: /@windows/ },
      ]
    : []),
  ...(RUN_WINDOWS
    ? [
        { name: "win-ja", use: winJa, grep: /^(?=.*@windows)(?=.*@screenshot)/ },
        { name: "win-en", use: winEn, grep: /^(?=.*@windows)(?=.*@screenshot)/ },
      ]
    : []),
];

export default defineConfig<AppLocaleOptions>({
  testDir: "./e2e",
  fullyParallel: true,
  // CI (macos-15) は 3 vCPU。未指定だと半分 (1 worker) になるため明示する
  workers: process.env.CI ? 3 : undefined,
  reporter: [["list"]],
  // 開発サーバー (Vite) を一度開いて変換を済ませてから、並列で開く
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:1420",
    ...devices["Desktop Safari"],
    deviceScaleFactor: 2,
  },
  projects: SCREENSHOTS ? screenshotProjects : testProjects,
  webServer: {
    command: "pnpm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
