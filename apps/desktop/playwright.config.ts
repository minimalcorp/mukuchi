import { defineConfig, devices } from "@playwright/test";
import type { AppLocaleOptions } from "./e2e/fixtures";

// モック (src/mock) で各ウィンドウ・状態を開いて確認する。
// Tauri の WebView (WKWebView) に近い WebKit で実行する。
// 表示言語ごとに同じテストを回す (モックの OS の言語を e2e/fixtures.ts の appLocale で切り替える)
export default defineConfig<AppLocaleOptions>({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1420",
    ...devices["Desktop Safari"],
    deviceScaleFactor: 2,
  },
  projects: [
    { name: "ja", use: { browserName: "webkit", appLocale: "ja" } },
    { name: "en", use: { browserName: "webkit", appLocale: "en" } },
  ],
  webServer: {
    command: "pnpm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
