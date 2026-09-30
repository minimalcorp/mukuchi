/*
 * P4 (セットアップ・ストレージ) の確認: provisioning の状態表示・一時停止/再開/再試行・開き直した時の再開、
 * complete_setup の条件、実行環境とモデルの削除、アンインストール。
 */
import { expect, test, type Page } from "@playwright/test";

const SETUP = { width: 640, height: 520 };
const SETTINGS = { width: 840, height: 640 };

type Call = { cmd: string; args: Record<string, unknown> };
type Size = { width: number; height: number };

async function open(page: Page, query: string, viewport: Size) {
  await page.setViewportSize(viewport);
  await page.goto(`/?${query}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => "__mukuchiMock" in window);
}

function calls(page: Page, cmd: string): Promise<Call[]> {
  return page.evaluate(
    (c) =>
      (window as unknown as { __mukuchiMock: { calls: Call[] } }).__mukuchiMock.calls.filter((x) => x.cmd === c),
    cmd,
  );
}

async function mock(page: Page, fn: string) {
  await page.evaluate(`(() => { const api = window.__mukuchiMock; ${fn} })()`);
}

const item = (page: Page, id: string) => page.getByTestId(`provisioning-item-${id}`);

function modelBytes(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __mukuchiMock: { db: { provisioning: { bytesDone: number } } } }).__mukuchiMock.db
        .provisioning.bytesDone,
  );
}

// ---------- セットアップ: ダウンロード ----------

test("setup: runtime → model → verify と進み、done になってから次へ進める", async ({ page }) => {
  await open(page, "window=setup&mock=download-live", SETUP);
  const next = page.getByRole("button", { name: "次へ" });
  // 未開始なら開始する
  await expect.poll(async () => (await calls(page, "start_provisioning")).length).toBe(1);
  // runtime は大きさを出さない
  await expect(item(page, "runtime")).toContainText("準備しています…");
  await expect(page.getByText("実行環境を準備しています")).toBeVisible();
  await expect(next).toBeDisabled();
  // model はバイト数、全体も model のみ
  await expect(item(page, "runtime")).toContainText("完了");
  await expect(item(page, "model")).toContainText(/\d\.\d \/ 2\.4 GB/);
  await expect(page.getByText(/GB \/ 2\.4 GB/)).toBeVisible();
  // verify
  await expect(item(page, "verify")).toContainText("確認しています…", { timeout: 10_000 });
  await expect(next).toBeDisabled();
  await expect(item(page, "verify")).toHaveAttribute("data-state", "done", { timeout: 5000 });
  await expect(next).toBeEnabled();
  await expect(page.getByText("実行環境とモデルの準備ができました")).toBeVisible();
});

test("setup: 一時停止は止まるまで押せず、止まった項目は active のまま。再開で続きから進む", async ({ page }) => {
  await open(page, "window=setup&mock=download-live", SETUP);
  await expect(item(page, "model")).toHaveAttribute("data-state", "active", { timeout: 5000 });
  await expect.poll(() => modelBytes(page)).toBeGreaterThan(0);
  const pause = page.getByRole("button", { name: "一時停止" });
  await pause.click();
  // pause_provisioning が返るまで (止まるまで) は押せない
  await expect(pause).toBeDisabled();
  await expect(page.getByText("ダウンロードを一時停止しました")).toBeVisible();
  await expect(item(page, "model")).toHaveAttribute("data-state", "active");
  await expect(page.getByText(/一時停止中/).first()).toBeVisible();
  const before = await modelBytes(page);
  await page.getByRole("button", { name: "再開" }).click();
  await expect.poll(async () => (await calls(page, "start_provisioning")).length).toBe(2);
  await expect(page.getByText("実行環境とモデルをダウンロードしています")).toBeVisible();
  // 続きから (取得済みの量から減らない)
  expect(await modelBytes(page)).toBeGreaterThanOrEqual(before);
});

test("setup: 失敗したら表示用の文言を出し、再試行は start_provisioning", async ({ page }) => {
  await open(page, "window=setup&mock=download-error", SETUP);
  await expect(page.getByRole("alert")).toContainText("モデルのダウンロードに失敗しました。");
  await expect(item(page, "model")).toHaveAttribute("data-state", "active");
  await expect(page.getByRole("button", { name: "一時停止" })).toBeDisabled();
  await page.getByRole("button", { name: "再試行" }).click();
  await expect.poll(async () => (await calls(page, "start_provisioning")).length).toBe(1);
  await expect(page.getByText("実行環境とモデルをダウンロードしています")).toBeVisible();
});

test("setup: runtime の失敗では取得済みの量を出さない", async ({ page }) => {
  await open(page, "window=setup&mock=download-error-runtime", SETUP);
  await expect(page.getByRole("alert")).toContainText("実行環境を導入できませんでした。");
  await expect(page.getByRole("alert")).not.toContainText("取得済み");
});

test("setup: 導入の途中で開き直したらダウンロードのステップから現在の状態で再開する", async ({ page }) => {
  await open(page, "window=setup&mock=resume", SETUP);
  await expect(page.getByText("ダウンロードを一時停止しました")).toBeVisible();
  await expect(page.getByText("0.9 GB / 2.4 GB ・ 一時停止中")).toBeVisible();
  // 一時停止中は自動で開始しない
  expect(await calls(page, "start_provisioning")).toHaveLength(0);
});

test("setup: 未導入で開いたらようこそから始める", async ({ page }) => {
  await open(page, "window=setup&mock=default", SETUP);
  await expect(page.getByText("mukuchi へようこそ")).toBeVisible();
});

test("setup: 導入が済むまで complete_setup を呼ばない", async ({ page }) => {
  await open(page, "window=setup&mock=done", SETUP);
  const closeButton = page.getByRole("button", { name: "閉じる" });
  await expect(closeButton).toBeEnabled();
  await mock(page, `api.db.provisioning = { ...api.db.provisioning, stage: "verify" }; api.fire("provisioning-progress", api.db.provisioning);`);
  await expect(closeButton).toBeDisabled();
  await mock(page, `api.db.provisioning = { ...api.db.provisioning, stage: "done" }; api.fire("provisioning-progress", api.db.provisioning);`);
  await closeButton.click();
  await expect.poll(async () => (await calls(page, "complete_setup")).length).toBe(1);
});

test("setup: complete_setup の失敗を表示する", async ({ page }) => {
  await open(page, "window=setup&mock=done", SETUP);
  await mock(page, `api.fail.complete_setup = "セットアップを完了できませんでした";`);
  await page.getByRole("button", { name: "閉じる" }).click();
  await expect(page.getByRole("alert")).toContainText("セットアップを完了できませんでした");
});

// ---------- 設定: ストレージ ----------

test("settings: 実行環境とモデルを削除すると使用量を取り直し、セットアップへの案内を出す", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=storage", SETTINGS);
  await expect(page.getByText("3.6 GB")).toBeVisible();
  await expect(page.getByTestId("runtime-missing")).toHaveCount(0);
  await page.getByRole("button", { name: "削除", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "削除", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await calls(page, "delete_runtime_and_model")).toHaveLength(1);
  await expect(page.getByTestId("runtime-missing")).toBeVisible();
  await expect(page.getByText("12 MB").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "削除", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "セットアップを開く" }).click();
  await expect.poll(async () => (await calls(page, "open_setup")).length).toBe(1);
});

test("settings: 削除に失敗したらダイアログにメッセージを出す", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=storage", SETTINGS);
  await mock(page, `api.fail.delete_runtime_and_model = "モデルを削除できませんでした";`);
  await page.getByRole("button", { name: "削除", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "削除", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("モデルを削除できませんでした");
});

test("settings: 使用量を取得できなければエラーを出す", async ({ page }) => {
  await page.setViewportSize(SETTINGS);
  await page.goto("/?window=settings&mock=default&category=general");
  await page.waitForFunction(() => "__mukuchiMock" in window);
  await mock(page, `api.fail.get_storage_usage = "使用量を計算できませんでした";`);
  await page.getByRole("button", { name: "ストレージ" }).click();
  await expect(page.getByRole("alert")).toContainText("使用量を計算できませんでした");
  await expect(page.getByText("—")).toBeVisible();
});

test("settings: アンインストール中は取り消せず、終わるまで操作できない", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=storage", SETTINGS);
  await page.getByRole("button", { name: "アンインストール…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("合計 3.7 GB")).toBeVisible();
  await dialog.getByRole("button", { name: "アンインストール", exact: true }).click();
  await expect(dialog.getByText("アンインストールしています…", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "キャンセル" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "アンインストール", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  // モックは dry run と同じく終了せずに返る
  await expect(dialog.getByText("アンインストールしました。", { exact: false })).toBeVisible();
  expect(await calls(page, "uninstall")).toHaveLength(1);
});

test("settings: アンインストールに失敗したらダイアログにメッセージを出して閉じられる", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=storage", SETTINGS);
  await mock(page, `api.fail.uninstall = "アプリ本体をゴミ箱に入れられませんでした";`);
  await page.getByRole("button", { name: "アンインストール…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "アンインストール", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("アプリ本体をゴミ箱に入れられませんでした");
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("settings: 削除対象を取得できなければアンインストールさせない", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=storage", SETTINGS);
  await mock(page, `api.fail.get_uninstall_targets = "削除対象を確認できませんでした";`);
  await page.getByRole("button", { name: "アンインストール…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toHaveText("削除対象を確認できませんでした");
  await expect(dialog.getByRole("button", { name: "アンインストール", exact: true })).toBeDisabled();
});
