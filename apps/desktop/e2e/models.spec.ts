/*
 * モデルの管理 (設定 > 認識) の確認: 状態ごとの表示・取得 (進捗・一時停止・再開・中止)・切り替え・削除の確認・エラー。
 * スクリーンショットは e2e/screenshots/settings-models-*.png。
 */
import { expect, test, type Page } from "@playwright/test";

const SETTINGS = { width: 840, height: 640 };

type Call = { cmd: string; args: Record<string, unknown> };

async function open(page: Page, mockName: string, dark = false) {
  await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
  await page.setViewportSize(SETTINGS);
  await page.goto(`/?window=settings&mock=${mockName}&category=recognition`);
  // 描画されてから待つ (描画前は同梱フォントの読み込みが始まっておらず、fonts.ready がすぐ解決する)
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => "__mukuchiMock" in window);
  await expect(page.getByTestId("model-ja-8bit")).toBeVisible();
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

/** モデルの行 (情報と操作ボタン) */
const row = (page: Page, id: string) => page.getByTestId(`model-${id}`).locator("xpath=..");
const shot = (page: Page, name: string) => page.screenshot({ path: `e2e/screenshots/settings-models-${name}.png` });

// ---------- 表示 ----------

for (const dark of [false, true]) {
  const suffix = dark ? "-dark" : "";

  test(`既定: 8bit を使用中 (推奨)、bf16 は未取得${suffix}`, async ({ page }) => {
    await open(page, "default", dark);
    const r8 = row(page, "ja-8bit");
    await expect(r8).toContainText("日本語 (8bit)");
    await expect(r8).toContainText("推奨");
    await expect(r8).toContainText("使用中");
    await expect(r8).toContainText("ダウンロード済み ・ 2.2 GB");
    const rb = row(page, "ja-bf16");
    await expect(rb).toContainText("未ダウンロード ・ 4.1 GB");
    await expect(rb).not.toContainText("推奨");
    await expect(rb.getByRole("button", { name: "ダウンロード" })).toBeEnabled();
    await shot(page, `default${suffix}`);
  });

  test(`取得中: 進捗バー・残り時間・一時停止・中止${suffix}`, async ({ page }) => {
    await open(page, "models-downloading", dark);
    const rb = row(page, "ja-bf16");
    await expect(rb).toContainText("1.5 / 4.1 GB ・ 残り約 3 分");
    await expect(rb.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "37");
    await expect(rb.getByRole("button", { name: "一時停止" })).toBeEnabled();
    await expect(rb.getByRole("button", { name: "中止" })).toBeEnabled();
    await shot(page, `downloading${suffix}`);
  });
}

test("一時停止: 再開・中止", async ({ page }) => {
  await open(page, "models-paused");
  const rb = row(page, "ja-bf16");
  await expect(rb).toContainText("一時停止中 ・ 1.5 / 4.1 GB");
  await expect(rb.getByRole("button", { name: "再開" })).toBeEnabled();
  await expect(rb.getByRole("button", { name: "中止" })).toBeEnabled();
  await shot(page, "paused");
});

test("失敗: 理由を表示し、再試行で取得を再開する", async ({ page }) => {
  await open(page, "models-error");
  const rb = row(page, "ja-bf16");
  await expect(rb).toContainText("失敗 ・ 1.5 / 4.1 GB");
  await expect(rb.getByRole("alert")).toHaveText("モデルのダウンロードに失敗しました。ネットワーク接続を確認してください。");
  await shot(page, "error");
  await rb.getByRole("button", { name: "再試行" }).click();
  await expect(page.getByTestId("model-ja-bf16")).toHaveAttribute("data-state", "downloading");
  await expect(rb.getByRole("alert")).toHaveCount(0);
  expect(await calls(page, "download_model")).toEqual([{ cmd: "download_model", args: { id: "ja-bf16" } }]);
});

test("使用中のモデルは削除できず、理由を Tooltip で示す", async ({ page }) => {
  await open(page, "default");
  const del = row(page, "ja-8bit").getByRole("button", { name: "削除" });
  await expect(del).toBeDisabled();
  await page.getByLabel("使用中のモデルは削除できません。", { exact: false }).hover();
  await expect(page.getByRole("tooltip")).toContainText("他のモデルに切り替えてから削除してください");
  await shot(page, "in-use-tooltip");
});

test("セットアップ未完了: 案内を出し、操作できない", async ({ page }) => {
  await open(page, "models-setup-incomplete");
  await expect(page.getByTestId("models-setup-incomplete")).toContainText("セットアップが完了するまで");
  await expect(row(page, "ja-8bit").getByRole("button", { name: "再開" })).toBeDisabled();
  await expect(row(page, "ja-8bit").getByRole("button", { name: "中止" })).toBeDisabled();
  await expect(row(page, "ja-bf16").getByRole("button", { name: "ダウンロード" })).toBeDisabled();
  await shot(page, "setup-incomplete");
});

test("同時に取得できるのは1つ: 他が取得中ならダウンロード・再開を押せない", async ({ page }) => {
  await open(page, "models-downloading");
  // 実カタログは2件 (使用中は取得済み) のため、3件目を足して確認する
  await mock(
    page,
    `const extra = { ...api.db.models[1], id: "extra", name: "追加のモデル", state: "not_downloaded", bytesDone: 0, diskBytes: 0, etaSeconds: null };
     const paused = { ...api.db.models[1], id: "extra2", name: "止めたモデル", state: "paused", etaSeconds: null };
     api.db.models = [...api.db.models, extra, paused];
     api.fire("models-changed", api.db.models);`,
  );
  const download = row(page, "extra").getByRole("button", { name: "ダウンロード" });
  await expect(download).toBeDisabled();
  await expect(row(page, "extra2").getByRole("button", { name: "再開" })).toBeDisabled();
  // 止めたものの中止はできる
  await expect(row(page, "extra2").getByRole("button", { name: "中止" })).toBeEnabled();
  await row(page, "extra").getByLabel("他のモデルをダウンロード中です", { exact: false }).hover();
  await expect(page.getByRole("tooltip")).toContainText("同時にダウンロードできるのは 1 つです");
});

// ---------- 取得 ----------

test("取得: 開始 → 進捗 → 一時停止 → 再開 → 完了で「使う」が出る", async ({ page }) => {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await open(page, "default");
  const rb = row(page, "ja-bf16");
  await rb.getByRole("button", { name: "ダウンロード" }).click();
  expect(await calls(page, "download_model")).toEqual([{ cmd: "download_model", args: { id: "ja-bf16" } }]);
  await page.clock.runFor(250);
  // 最初の約2秒は残り時間が出ない
  await expect(rb).toContainText("0.1 / 4.1 GB ・ 残り時間を計算しています");
  await page.clock.runFor(2000);
  await expect(rb).toContainText(/\d\.\d \/ 4\.1 GB ・ 残り約 \d+ 分|残り 1 分未満/);
  // 一時停止は止まるまで (300ms) 押せない
  await rb.getByRole("button", { name: "一時停止" }).click();
  await expect(rb.getByRole("button", { name: "中止" })).toBeDisabled();
  await page.clock.runFor(300);
  await expect(rb).toContainText("一時停止中 ・ 0.9 / 4.1 GB");
  await rb.getByRole("button", { name: "再開" }).click();
  await expect(page.getByTestId("model-ja-bf16")).toHaveAttribute("data-state", "downloading");
  await page.clock.runFor(250 * 35);
  await expect(page.getByTestId("model-ja-bf16")).toHaveAttribute("data-state", "downloaded");
  await expect(rb).toContainText("ダウンロード済み ・ 4.1 GB");
  await expect(rb.getByRole("button", { name: "使う" })).toBeEnabled();
  await expect(rb.getByRole("button", { name: "削除" })).toBeEnabled();
});

test("取得: 中止すると未取得に戻る", async ({ page }) => {
  await open(page, "models-paused");
  const rb = row(page, "ja-bf16");
  await rb.getByRole("button", { name: "中止" }).click();
  await expect(page.getByTestId("model-ja-bf16")).toHaveAttribute("data-state", "not_downloaded");
  await expect(rb).toContainText("未ダウンロード ・ 4.1 GB");
  expect(await calls(page, "cancel_model_download")).toEqual([{ cmd: "cancel_model_download", args: { id: "ja-bf16" } }]);
});

test("取得: command の失敗はその行に表示する", async ({ page }) => {
  await open(page, "default");
  await mock(page, `api.fail.download_model = "他のモデルをダウンロード中です";`);
  const rb = row(page, "ja-bf16");
  await rb.getByRole("button", { name: "ダウンロード" }).click();
  await expect(rb.getByRole("alert")).toHaveText("他のモデルをダウンロード中です");
});

// ---------- 切り替え ----------

test("切り替え: loading を経由する間は処理中表示で操作できず、完了で使用中が移る", async ({ page }) => {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await open(page, "models-both");
  const r8 = row(page, "ja-8bit");
  const rb = row(page, "ja-bf16");
  await expect(rb).toContainText("使用中");
  await r8.getByRole("button", { name: "使う" }).click();
  await expect(r8.getByRole("button", { name: "切り替えています…" })).toBeDisabled();
  await expect(r8.getByRole("button", { name: "削除" })).toHaveCount(0);
  await expect(page.getByText("読み込み中")).toBeVisible();
  await shot(page, "switching");
  expect(await calls(page, "select_model")).toEqual([{ cmd: "select_model", args: { id: "ja-8bit" } }]);
  await page.clock.runFor(1000);
  await expect(r8).toContainText("使用中");
  await expect(rb.getByRole("button", { name: "使う" })).toBeEnabled();
  await expect(page.getByText("読み込み済み")).toBeVisible();
});

test("切り替え: 失敗すると元のモデルに戻り、エラーを表示する", async ({ page }) => {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await open(page, "models-both");
  await mock(page, `api.db.modelSelectFail = "『日本語 (8bit)』を読み込めませんでした。『日本語 (bf16)』に戻しました";`);
  await row(page, "ja-8bit").getByRole("button", { name: "使う" }).click();
  await page.clock.runFor(1000);
  await expect(page.getByRole("alert")).toHaveText("『日本語 (8bit)』を読み込めませんでした。『日本語 (bf16)』に戻しました");
  await expect(row(page, "ja-bf16")).toContainText("使用中");
  await expect(row(page, "ja-8bit").getByRole("button", { name: "使う" })).toBeEnabled();
  await shot(page, "switch-failed");
});

// ---------- 削除 ----------

test("削除: 確認ダイアログでキャンセルすると消さず、削除すると未取得になる", async ({ page }) => {
  await open(page, "models-both");
  const r8 = row(page, "ja-8bit");
  await r8.getByRole("button", { name: "削除" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("モデルを削除しますか？");
  await expect(dialog).toContainText("「日本語 (8bit)」（2.2 GB）を削除します。");
  await shot(page, "delete-dialog");
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await calls(page, "delete_model")).toHaveLength(0);

  await r8.getByRole("button", { name: "削除" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "削除" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("model-ja-8bit")).toHaveAttribute("data-state", "not_downloaded");
  expect(await calls(page, "delete_model")).toEqual([{ cmd: "delete_model", args: { id: "ja-8bit" } }]);
});

test("削除: 失敗はダイアログに表示し、閉じない", async ({ page }) => {
  await open(page, "models-both");
  await mock(page, `api.fail.delete_model = "削除を実行中です";`);
  await row(page, "ja-8bit").getByRole("button", { name: "削除" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "削除" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("削除を実行中です");
  await expect(page.getByTestId("model-ja-8bit")).toHaveAttribute("data-state", "downloaded");
});

test("一覧の取得に失敗したらエラーを表示する", async ({ page }) => {
  await page.goto("/?window=settings&mock=default&category=general");
  await page.waitForFunction(() => "__mukuchiMock" in window);
  await mock(page, `api.fail.list_models = "モデルの一覧を取得できませんでした";`);
  await page.getByRole("button", { name: "認識" }).click();
  await expect(page.getByRole("alert")).toHaveText("モデルの一覧を取得できませんでした");
});
