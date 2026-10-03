/*
 * 設定 > このアプリについて のアップデートの確認: 手動の確認 (最新・新しい版の取得から再起動まで)、
 * unavailable での無効化、自動確認の切り替え、command の失敗の表示。
 */
import { expect, test, type Page } from "@playwright/test";

const SETTINGS = { width: 840, height: 640 };

type Call = { cmd: string; args: Record<string, unknown> };
type Mock = {
  calls: Call[];
  fail: Record<string, string>;
  db: { settings: Record<string, unknown>; updateInstallError: string | null };
};

async function open(page: Page, mock: string) {
  await page.setViewportSize(SETTINGS);
  await page.goto(`/?window=settings&mock=${mock}&category=about`);
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0);
  await page.waitForFunction(() => "__mukuchiMock" in window);
}

function calls(page: Page, cmd: string): Promise<Call[]> {
  return page.evaluate((c) => (window as unknown as { __mukuchiMock: Mock }).__mukuchiMock.calls.filter((x) => x.cmd === c), cmd);
}

test("about: 確認して最新なら最終確認の時刻を出す", async ({ page }) => {
  await open(page, "update-unchecked");
  await expect(page.getByText("まだ確認していません")).toBeVisible();
  await page.getByRole("button", { name: "アップデートを確認" }).click();
  await expect(page.getByTestId("update-status")).toHaveAttribute("data-state", "checking");
  await expect(page.getByText("最新のバージョンです")).toBeVisible();
  await expect(page.getByText(/最終確認 今日 \d+:\d{2}/)).toBeVisible();
  expect(await calls(page, "check_for_update")).toHaveLength(1);
});

test("about: 新しい版を取得して ready になり、再起動してアップデートを押すと install_update", async ({ page }) => {
  await open(page, "update-available");
  await page.getByRole("button", { name: "アップデートを確認" }).click();
  await expect(page.getByText("v0.2.0 をダウンロードしています")).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "アップデートのダウンロード" })).toBeVisible();
  // 取得中は確認を押させない (Rust も何もしない)
  await expect(page.getByRole("button", { name: "アップデートを確認" })).toBeDisabled();
  await expect(page.getByText("v0.2.0 の準備ができました")).toBeVisible({ timeout: 5000 });
  await page.getByRole("button", { name: "再起動してアップデート" }).click();
  await expect(page.getByText("v0.2.0 をインストールしています…")).toBeVisible();
  expect(await calls(page, "install_update")).toHaveLength(1);
});

test("about: unavailable では確認ボタンを無効にし、理由を出す", async ({ page }) => {
  await open(page, "update-unavailable");
  await expect(page.getByText("アプリケーションフォルダに移動すると自動でアップデートできます")).toBeVisible();
  await expect(page.getByRole("button", { name: "アップデートを確認" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "再起動してアップデート" })).toHaveCount(0);
});

test("about: 自動確認のスイッチで autoCheckUpdates を保存する", async ({ page }) => {
  await open(page, "default");
  const sw = page.getByRole("switch", { name: "自動でアップデートを確認" });
  await expect(sw).toBeChecked();
  await sw.click();
  await expect(sw).not.toBeChecked();
  expect((await calls(page, "update_settings")).map((c) => c.args.patch)).toEqual([{ autoCheckUpdates: false }]);
});

test("about: install_update の失敗を表示する", async ({ page }) => {
  await open(page, "update-ready");
  await page.evaluate(() => {
    (window as unknown as { __mukuchiMock: Mock }).__mukuchiMock.fail["install_update"] = "ダウンロード・削除の実行中は更新できません";
  });
  await page.getByRole("button", { name: "再起動してアップデート" }).click();
  await expect(page.getByRole("alert")).toHaveText("ダウンロード・削除の実行中は更新できません");
});

test("about: インストールに失敗して error になったら、失敗の文言は状態表示に1回だけ出す", async ({ page }) => {
  await open(page, "update-ready");
  await page.evaluate(() => {
    (window as unknown as { __mukuchiMock: Mock }).__mukuchiMock.db.updateInstallError = "アップデートをインストールできませんでした";
  });
  await page.getByRole("button", { name: "再起動してアップデート" }).click();
  await expect(page.getByTestId("update-status")).toHaveAttribute("data-state", "error");
  await expect(page.getByText("v0.2.0 へのアップデートに失敗しました")).toBeVisible();
  await expect(page.getByText("アップデートをインストールできませんでした")).toHaveCount(1);
  await expect(page.getByTestId("update-status").getByText("アップデートをインストールできませんでした")).toBeVisible();
});
