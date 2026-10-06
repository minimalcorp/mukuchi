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
// pnpm screenshots (SCREENSHOTS=1) は撮影するテスト (@screenshot・@screenshot-only) だけを ja・en で回す
const SCREENSHOTS = Boolean(process.env.SCREENSHOTS);

const ja = { browserName: "webkit" as const, appLocale: "ja" as const };
const en = { browserName: "webkit" as const, appLocale: "en" as const };

const testProjects: Project<AppLocaleOptions>[] = [
  { name: "ja", use: ja, grepInvert: /@timing|@screenshot-only/ },
  { name: "en", use: en, grep: /@i18n/, grepInvert: /@timing|@screenshot-only/ },
  { name: "ja-timing", use: ja, grep: /@timing/, workers: 1, dependencies: ["ja", "en"] },
  // @timing かつ @i18n (タグの順序によらない)
  { name: "en-timing", use: en, grep: /^(?=.*@timing)(?=.*@i18n)/, workers: 1, dependencies: ["ja-timing"] },
];

const screenshotProjects: Project<AppLocaleOptions>[] = [
  { name: "ja", use: ja, grep: /@screenshot/ },
  { name: "en", use: en, grep: /@screenshot/ },
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
