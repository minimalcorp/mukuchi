import { defineConfig, devices } from "@playwright/test";

// モック (src/mock) で各ウィンドウ・状態を開いて確認する。
// Tauri の WebView (WKWebView) に近い WebKit で実行する
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:1420",
    ...devices["Desktop Safari"],
    deviceScaleFactor: 2,
  },
  projects: [{ name: "webkit", use: { browserName: "webkit" } }],
  webServer: {
    command: "pnpm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
