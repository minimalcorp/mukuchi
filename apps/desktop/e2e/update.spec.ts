/*
 * 設定 > このアプリについて のアップデートの確認: 手動の確認 (最新・新しい版の取得から再起動まで)、
 * unavailable での無効化、自動確認の切り替え、command の失敗の表示。
 */
import type { Page } from "@playwright/test";
import { expect, I18N, test } from "./fixtures";

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

// 時刻は Intl の書式 (表示言語で違う)
test("about: 確認して最新なら最終確認の時刻を出す", { tag: I18N }, async ({ page, m }) => {
  await open(page, "update-unchecked");
  await expect(page.getByText(m.settings.about.notChecked)).toBeVisible();
  await page.getByRole("button", { name: m.settings.about.check }).click();
  await expect(page.getByTestId("update-status")).toHaveAttribute("data-state", "checking");
  await expect(page.getByText(m.settings.about.upToDate)).toBeVisible();
  // 時刻は表示言語の書式 (Intl) のため、「最終確認 今日」の部分までを確かめる
  await expect(page.getByText(m.settings.about.lastChecked(m.format.today("")).trim())).toBeVisible();
  expect(await calls(page, "check_for_update")).toHaveLength(1);
});

test("about: 新しい版を取得して ready になり、再起動してアップデートを押すと install_update", async ({ page, m }) => {
  // 確認 (約 0.6 秒) と取得 (4 MB / 250ms、40 MB) を clock で進める
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await open(page, "update-available");
  await page.getByRole("button", { name: m.settings.about.check }).click();
  await expect(page.getByTestId("update-status")).toHaveAttribute("data-state", "checking");
  await page.clock.runFor(600);
  await expect(page.getByText(m.settings.about.downloading("v0.2.0"))).toBeVisible();
  await expect(page.getByRole("progressbar", { name: m.settings.about.downloadProgress })).toBeVisible();
  // 取得中は確認を押させない (Rust も何もしない)
  await expect(page.getByRole("button", { name: m.settings.about.check })).toBeDisabled();
  await page.clock.runFor(2500);
  await expect(page.getByText(m.settings.about.ready("v0.2.0"))).toBeVisible();
  await page.getByRole("button", { name: m.settings.about.install }).click();
  await expect(page.getByText(m.settings.about.installing("v0.2.0"))).toBeVisible();
  expect(await calls(page, "install_update")).toHaveLength(1);
});

test("about: unavailable では確認ボタンを無効にし、理由を出す", async ({ page, m, ui }) => {
  await open(page, "update-unavailable");
  await expect(page.getByText(ui.updateUnavailable)).toBeVisible();
  await expect(page.getByRole("button", { name: m.settings.about.check })).toBeDisabled();
  await expect(page.getByRole("button", { name: m.settings.about.install })).toHaveCount(0);
});

test("about: 自動確認のスイッチで autoCheckUpdates を保存する", async ({ page, m }) => {
  await open(page, "default");
  const sw = page.getByRole("switch", { name: m.settings.about.autoCheck });
  await expect(sw).toBeChecked();
  await sw.click();
  await expect(sw).not.toBeChecked();
  expect((await calls(page, "update_settings")).map((c) => c.args.patch)).toEqual([{ autoCheckUpdates: false }]);
});

test("about: install_update の失敗を表示する", async ({ page, m }) => {
  await open(page, "update-ready");
  await page.evaluate(() => {
    (window as unknown as { __mukuchiMock: Mock }).__mukuchiMock.fail["install_update"] = "ダウンロード・削除の実行中は更新できません";
  });
  await page.getByRole("button", { name: m.settings.about.install }).click();
  await expect(page.getByRole("alert")).toHaveText("ダウンロード・削除の実行中は更新できません");
});

test("about: インストールに失敗して error になったら、失敗の文言は状態表示に1回だけ出す", async ({ page, m }) => {
  await open(page, "update-ready");
  await page.evaluate(() => {
    (window as unknown as { __mukuchiMock: Mock }).__mukuchiMock.db.updateInstallError = "アップデートをインストールできませんでした";
  });
  await page.getByRole("button", { name: m.settings.about.install }).click();
  await expect(page.getByTestId("update-status")).toHaveAttribute("data-state", "error");
  await expect(page.getByText(m.settings.about.failed("v0.2.0"))).toBeVisible();
  await expect(page.getByText("アップデートをインストールできませんでした")).toHaveCount(1);
  await expect(page.getByTestId("update-status").getByText("アップデートをインストールできませんでした")).toBeVisible();
});
