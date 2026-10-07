/*
 * テストの前に開発サーバー (Vite) で各ウィンドウを一度開いておく。
 * 初回は依存の最適化・モジュールの変換で読み込みが遅く、並列の worker が同時に開くと最初のテストが待たされるため。
 * (依存は起動時の走査で見つかるので、読み込み中の再最適化による読み直しは起きない。node_modules/.vite がない状態で確認済み)
 */
import { webkit, type FullConfig } from "@playwright/test";

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL ?? "http://localhost:1420";
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage();
    for (const query of [
      "window=panel&mock=idle",
      "window=setup&mock=default",
      "window=settings&mock=default&category=general",
    ]) {
      await page.goto(`${baseURL}/?${query}`);
      await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0, null, { timeout: 60_000 });
    }
  } finally {
    await browser.close();
  }
}
