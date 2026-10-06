/*
 * モデルの管理 (設定 > 認識) の確認: 状態ごとの表示・取得 (進捗・一時停止・再開・中止)・切り替え・削除の確認・エラー、
 * 話す言語による並び・推奨・注記と、推奨モデルへの案内。
 * 一覧は話す言語の並び (ja: ja-8bit → base-1.7b-8bit、en: base-1.7b-8bit → ja-8bit)。新規の設定は話す言語 = 表示言語で、
 * 推奨 (先頭) を取得済み・使用中、もう一方は未取得。
 * bf16 は旧候補 (手元にある時だけ出る)。bf16 を含むシナリオは旧版から bf16 を使っていた人の状態。
 * スクリーンショット (pnpm screenshots) は e2e/screenshots/<言語>/settings-models-*.png。ダークは撮影だけ。
 */
import type { Page } from "@playwright/test";
import { expect, I18N, SCREENSHOT, SCREENSHOT_ONLY, test, type Locale } from "./fixtures";

const SETTINGS = { width: 840, height: 640 };

type Call = { cmd: string; args: Record<string, unknown> };
type ModelId = "ja-8bit" | "base-1.7b-8bit";

/** 話す言語の推奨 (先頭) ともう一方 */
const RECOMMENDED: Record<Locale, ModelId> = { ja: "ja-8bit", en: "base-1.7b-8bit" };
const OTHER: Record<Locale, ModelId> = { ja: "base-1.7b-8bit", en: "ja-8bit" };
const otherLocale = (l: Locale): Locale => (l === "ja" ? "en" : "ja");

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

/** 一覧の行の id (表示順) */
function rowIds(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid^="model-"][data-state]')
    .evaluateAll((els) => els.map((e) => (e.getAttribute("data-testid") ?? "").replace(/^model-/, "")));
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** モデルの行 (情報と操作ボタン) */
const row = (page: Page, id: string) => page.getByTestId(`model-${id}`).locator("xpath=..");

// ---------- 表示 ----------

for (const dark of [false, true]) {
  const suffix = dark ? "-dark" : "";
  // ダークは撮影だけ。既定の並び・推奨は話す言語で違うため en でも回す
  const tag = dark ? SCREENSHOT_ONLY : SCREENSHOT;

  test(`既定: 話す言語の推奨を使用中、もう一方は未取得。旧候補の bf16 は出ない${suffix}`, { tag: dark ? SCREENSHOT_ONLY : [I18N, SCREENSHOT] }, async ({ page, m, ui, snap, appLocale }) => {
    await open(page, "default", dark);
    const rec = RECOMMENDED[appLocale];
    const sep = m.common.separator;
    expect(await rowIds(page)).toEqual([rec, OTHER[appLocale]]);
    const rr = row(page, rec);
    await expect(rr).toContainText(ui.models[rec].name);
    await expect(rr).toContainText(m.settings.models.recommended);
    await expect(rr).toContainText(m.settings.models.inUse);
    await expect(rr).toContainText(`${m.settings.models.downloaded}${sep}2.2 GB`);
    // 切り替え先はあるが使用中のため削除は押せない
    await expect(rr.getByRole("button", { name: m.common.delete })).toBeDisabled();
    const ro = row(page, OTHER[appLocale]);
    await expect(ro).toContainText(`${m.settings.models.notDownloaded}${sep}2.2 GB`);
    await expect(ro).not.toContainText(m.settings.models.recommended);
    await expect(ro.getByRole("button", { name: m.common.download })).toBeEnabled();
    // 推奨を使っているため案内は出ない
    await expect(page.getByTestId("model-recommendation")).toHaveCount(0);
    await expect(page.getByTestId("model-ja-bf16")).toHaveCount(0);
    await snap(`settings-models-default${suffix}`);
  });

  test(`旧候補: bf16 が手元にあれば出て、使う・削除できる${suffix}`, { tag }, async ({ page, m, ui, snap }) => {
    await open(page, "models-legacy", dark);
    const rb = row(page, "ja-bf16");
    await expect(rb).toContainText(ui.models["ja-bf16"].name);
    await expect(rb).toContainText(`${m.settings.models.downloaded}${m.common.separator}4.1 GB`);
    await expect(rb).not.toContainText(m.settings.models.recommended);
    await expect(rb.getByRole("button", { name: m.settings.models.use })).toBeEnabled();
    await expect(rb.getByRole("button", { name: m.common.delete })).toBeEnabled();
    // 旧候補は並びの末尾
    expect((await rowIds(page)).at(-1)).toBe("ja-bf16");
    await snap(`settings-models-legacy${suffix}`);
  });

  test(`取得中: 進捗バー・残り時間・一時停止・中止${suffix}`, { tag }, async ({ page, m, snap }) => {
    await open(page, "models-downloading", dark);
    const rb = row(page, "ja-bf16");
    await expect(rb).toContainText(`1.5 / 4.1 GB${m.common.separator}${m.format.etaMinutes(3)}`);
    await expect(rb.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "37");
    await expect(rb.getByRole("button", { name: m.common.pause })).toBeEnabled();
    await expect(rb.getByRole("button", { name: m.settings.models.cancel })).toBeEnabled();
    await snap(`settings-models-downloading${suffix}`);
  });
}

test("失敗: 理由を表示し、再試行で取得を再開する", { tag: SCREENSHOT }, async ({ page, m, ui, snap }) => {
  await open(page, "models-error");
  const rb = row(page, "ja-bf16");
  await expect(rb).toContainText(`${m.settings.models.failed}${m.common.separator}1.5 / 4.1 GB`);
  await expect(rb.getByRole("alert")).toHaveText(ui.modelDownloadFailed);
  await snap("settings-models-error");
  await rb.getByRole("button", { name: m.common.retry }).click();
  await expect(page.getByTestId("model-ja-bf16")).toHaveAttribute("data-state", "downloading");
  await expect(rb.getByRole("alert")).toHaveCount(0);
  expect(await calls(page, "download_model")).toEqual([{ cmd: "download_model", args: { id: "ja-bf16" } }]);
});

test("使用中のモデルは削除できず、理由を Tooltip で示す", { tag: SCREENSHOT }, async ({ page, m, snap }) => {
  await open(page, "models-both");
  const del = row(page, "ja-bf16").getByRole("button", { name: m.common.delete });
  await expect(del).toBeDisabled();
  await page.getByLabel(m.settings.models.inUseCantDelete).hover();
  await expect(page.getByRole("tooltip")).toContainText(m.settings.models.inUseCantDelete);
  await snap("settings-models-in-use-tooltip");
});

test("セットアップ未完了: 案内を出し、操作できない", { tag: SCREENSHOT }, async ({ page, m, snap, appLocale }) => {
  await open(page, "models-setup-incomplete");
  const rec = RECOMMENDED[appLocale];
  await expect(page.getByTestId("models-setup-incomplete")).toContainText(m.settings.models.setupIncomplete);
  await expect(row(page, rec).getByRole("button", { name: m.common.resume })).toBeDisabled();
  await expect(row(page, rec).getByRole("button", { name: m.settings.models.cancel })).toBeDisabled();
  await expect(row(page, OTHER[appLocale]).getByRole("button", { name: m.common.download })).toBeDisabled();
  await expect(page.getByTestId("model-ja-bf16")).toHaveCount(0);
  // セットアップ完了前は推奨への案内も出さない
  await expect(page.getByTestId("model-recommendation")).toHaveCount(0);
  await snap("settings-models-setup-incomplete");
});

test("同時に取得できるのは1つ: 他が取得中ならダウンロード・再開を押せない", async ({ page, m, appLocale }) => {
  await open(page, "models-downloading");
  // 止まっているものも確かめるため、一時停止の行を足す
  await mock(
    page,
    `const paused = { ...api.db.models[1], id: "extra2", name: "止めたモデル", state: "paused", bytesDone: 0.5e9, diskBytes: 0.5e9, etaSeconds: null, selected: false };
     api.db.models = [...api.db.models, paused];
     api.fire("models-changed", api.db.models);`,
  );
  // 未取得 (もう一方のモデル) のダウンロードも押せない
  const download = row(page, OTHER[appLocale]).getByRole("button", { name: m.common.download });
  await expect(download).toBeDisabled();
  await expect(row(page, "extra2").getByRole("button", { name: m.common.resume })).toBeDisabled();
  // 止めたものの中止はできる
  await expect(row(page, "extra2").getByRole("button", { name: m.settings.models.cancel })).toBeEnabled();
  await row(page, OTHER[appLocale]).getByLabel(m.settings.models.downloadingElsewhere).hover();
  await expect(page.getByRole("tooltip")).toContainText(m.settings.models.downloadingElsewhere);
});

// ---------- 取得 ----------

test("取得: 一時停止中は再開・中止でき、再開 → 進捗 → 一時停止 → 再開 → 完了で「使う」が出る", { tag: SCREENSHOT }, async ({ page, m, snap }) => {
  const sep = m.common.separator;
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  // 旧候補は新たに取得を始められないため、途中で止まっているものを再開する
  await open(page, "models-paused");
  const rb = row(page, "ja-bf16");
  await expect(rb).toContainText(`${m.settings.models.paused}${sep}1.5 / 4.1 GB`);
  await expect(rb.getByRole("button", { name: m.settings.models.cancel })).toBeEnabled();
  await snap("settings-models-paused");
  await rb.getByRole("button", { name: m.common.resume }).click();
  expect(await calls(page, "download_model")).toEqual([{ cmd: "download_model", args: { id: "ja-bf16" } }]);
  await page.clock.runFor(250);
  // 最初の約2秒は残り時間が出ない
  await expect(rb).toContainText(`1.6 / 4.1 GB${sep}${m.settings.models.etaCalculating}`);
  await page.clock.runFor(2000);
  await expect(rb).toContainText(new RegExp(`\\d\\.\\d / 4\\.1 GB${escape(sep)}.+`));
  await expect(rb).not.toContainText(m.settings.models.etaCalculating);
  // 一時停止は止まるまで (300ms) 押せない
  await rb.getByRole("button", { name: m.common.pause }).click();
  await expect(rb.getByRole("button", { name: m.settings.models.cancel })).toBeDisabled();
  await page.clock.runFor(300);
  await expect(rb).toContainText(`${m.settings.models.paused}${sep}2.4 / 4.1 GB`);
  await rb.getByRole("button", { name: m.common.resume }).click();
  await expect(page.getByTestId("model-ja-bf16")).toHaveAttribute("data-state", "downloading");
  await page.clock.runFor(250 * 20);
  await expect(page.getByTestId("model-ja-bf16")).toHaveAttribute("data-state", "downloaded");
  await expect(rb).toContainText(`${m.settings.models.downloaded}${sep}4.1 GB`);
  await expect(rb.getByRole("button", { name: m.settings.models.use })).toBeEnabled();
  await expect(rb.getByRole("button", { name: m.common.delete })).toBeEnabled();
});

test("取得: 旧候補を中止すると一覧から消える", async ({ page, m }) => {
  await open(page, "models-paused");
  await row(page, "ja-bf16").getByRole("button", { name: m.settings.models.cancel }).click();
  await expect(page.getByTestId("model-ja-bf16")).toHaveCount(0);
  await expect(page.getByTestId("model-ja-8bit")).toBeVisible();
  expect(await calls(page, "cancel_model_download")).toEqual([{ cmd: "cancel_model_download", args: { id: "ja-bf16" } }]);
});

test("取得: command の失敗はその行に表示する", async ({ page, m }) => {
  await open(page, "models-paused");
  await mock(page, `api.fail.download_model = "他のモデルをダウンロード中です";`);
  const rb = row(page, "ja-bf16");
  await rb.getByRole("button", { name: m.common.resume }).click();
  await expect(rb.getByRole("alert")).toHaveText("他のモデルをダウンロード中です");
});

// ---------- 切り替え ----------

test("切り替え: loading を経由する間は処理中表示で操作できず、完了で使用中が移る。旧候補にも切り替えられる", { tag: SCREENSHOT }, async ({ page, m, snap }) => {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await open(page, "models-both");
  const r8 = row(page, "ja-8bit");
  const rb = row(page, "ja-bf16");
  await expect(rb).toContainText(m.settings.models.inUse);
  await r8.getByRole("button", { name: m.settings.models.use }).click();
  await expect(r8.getByRole("button", { name: m.settings.models.switching })).toBeDisabled();
  await expect(r8.getByRole("button", { name: m.common.delete })).toHaveCount(0);
  await expect(page.getByText(m.settings.recognition.loading, { exact: true })).toBeVisible();
  await snap("settings-models-switching");
  expect(await calls(page, "select_model")).toEqual([{ cmd: "select_model", args: { id: "ja-8bit" } }]);
  await page.clock.runFor(1000);
  await expect(r8).toContainText(m.settings.models.inUse);
  await expect(rb.getByRole("button", { name: m.settings.models.use })).toBeEnabled();
  await expect(page.getByText(m.settings.recognition.loaded, { exact: true })).toBeVisible();
  // 旧候補 (bf16) にも切り替えられる
  await rb.getByRole("button", { name: m.settings.models.use }).click();
  await page.clock.runFor(1000);
  await expect(rb).toContainText(m.settings.models.inUse);
  await expect(r8.getByRole("button", { name: m.settings.models.use })).toBeEnabled();
});

test("切り替え: 失敗すると元のモデルに戻り、エラーを表示する", { tag: SCREENSHOT }, async ({ page, m, snap }) => {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await open(page, "models-both");
  await mock(page, `api.db.modelSelectFail = "『日本語 (8bit)』を読み込めませんでした。『日本語 (bf16)』に戻しました";`);
  await row(page, "ja-8bit").getByRole("button", { name: m.settings.models.use }).click();
  await page.clock.runFor(1000);
  await expect(page.getByRole("alert")).toHaveText("『日本語 (8bit)』を読み込めませんでした。『日本語 (bf16)』に戻しました");
  await expect(row(page, "ja-bf16")).toContainText(m.settings.models.inUse);
  await expect(row(page, "ja-8bit").getByRole("button", { name: m.settings.models.use })).toBeEnabled();
  await snap("settings-models-switch-failed");
});

// ---------- 削除 ----------

test("削除: 確認ダイアログでキャンセルすると消さず、削除すると未取得になる", { tag: SCREENSHOT }, async ({ page, m, ui, snap }) => {
  await open(page, "models-both");
  const r8 = row(page, "ja-8bit");
  await r8.getByRole("button", { name: m.common.delete }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(m.settings.models.deleteTitle);
  await expect(dialog).toContainText(m.settings.models.deleteDescription(ui.models["ja-8bit"].name, "2.2 GB"));
  await snap("settings-models-delete-dialog");
  await dialog.getByRole("button", { name: m.common.cancel }).click();
  await expect(dialog).toHaveCount(0);
  expect(await calls(page, "delete_model")).toHaveLength(0);

  await r8.getByRole("button", { name: m.common.delete }).click();
  await page.getByRole("dialog").getByRole("button", { name: m.common.delete }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("model-ja-8bit")).toHaveAttribute("data-state", "not_downloaded");
  expect(await calls(page, "delete_model")).toEqual([{ cmd: "delete_model", args: { id: "ja-8bit" } }]);
});

test("一覧が1件の時は使用中の行に削除ボタンを出さない", async ({ page, m, appLocale }) => {
  await open(page, "default");
  const rec = RECOMMENDED[appLocale];
  // 切り替え先がない一覧 (現在のカタログでは起きないが、仕組みとして確かめる)
  await mock(page, `api.db.models = api.db.models.filter((x) => x.id === "${rec}"); api.fire("models-changed", api.db.models);`);
  await expect(page.getByTestId(`model-${OTHER[appLocale]}`)).toHaveCount(0);
  await expect(row(page, rec).getByRole("button", { name: m.common.delete })).toHaveCount(0);
});

test("実行環境とモデルのみ削除の後は話す言語の推奨 (未取得・選択中) が選ばれ、旧候補は消える", async ({ page, m, appLocale }) => {
  await open(page, "models-both");
  await mock(page, `void api.invoke("delete_runtime_and_model");`);
  const rec = RECOMMENDED[appLocale];
  await expect(page.getByTestId("model-ja-bf16")).toHaveCount(0);
  await expect(page.getByTestId(`model-${rec}`)).toHaveAttribute("data-state", "not_downloaded");
  await expect(page.getByTestId(`model-${OTHER[appLocale]}`)).toHaveAttribute("data-state", "not_downloaded");
  await expect(row(page, rec)).toContainText(m.settings.models.inUse);
});

test("削除: 失敗はダイアログに表示し、閉じない", async ({ page, m }) => {
  await open(page, "models-both");
  await mock(page, `api.fail.delete_model = "削除を実行中です";`);
  await row(page, "ja-8bit").getByRole("button", { name: m.common.delete }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: m.common.delete }).click();
  await expect(dialog.getByRole("alert")).toHaveText("削除を実行中です");
  await expect(page.getByTestId("model-ja-8bit")).toHaveAttribute("data-state", "downloaded");
});

test("一覧の取得に失敗したらエラーを表示する", async ({ page, m }) => {
  await page.goto("/?window=settings&mock=default&category=general");
  await page.waitForFunction(() => "__mukuchiMock" in window);
  await mock(page, `api.fail.list_models = "モデルの一覧を取得できませんでした";`);
  await page.getByRole("button", { name: m.settings.categories.recognition }).click();
  await expect(page.getByRole("alert")).toHaveText("モデルの一覧を取得できませんでした");
});

// ---------- 話す言語 ----------

// 並び・推奨・注記 (tunedFor) は話す言語で分かれる
test("話す言語: 変えると一覧が並び替わり、推奨と注記が移る。使用中は変えず推奨を案内する", { tag: [I18N, SCREENSHOT] }, async ({ page, m, ui, snap, appLocale }) => {
  await open(page, "default");
  const other = otherLocale(appLocale);
  const tuned = page.getByTestId("model-ja-8bit-tuned");
  // 日本語向けのモデルは、話す言語が日本語でない時だけ注記する
  await expect(tuned).toHaveCount(appLocale === "ja" ? 0 : 1);
  await page.getByTestId("speech-language").selectOption(other);
  expect((await calls(page, "update_settings")).map((c) => c.args.patch)).toEqual([{ speechLanguage: other }]);
  await expect.poll(() => rowIds(page)).toEqual([RECOMMENDED[other], OTHER[other]]);
  await expect(row(page, RECOMMENDED[other])).toContainText(m.settings.models.recommended);
  await expect(row(page, OTHER[other])).not.toContainText(m.settings.models.recommended);
  await expect(tuned).toHaveCount(other === "ja" ? 0 : 1);
  if (other === "en") await expect(tuned).toHaveText(m.settings.models.tunedFor(m.languageName.ja));
  // 使用中のモデルは自動では切り替えない
  await expect(row(page, RECOMMENDED[appLocale])).toContainText(m.settings.models.inUse);
  const notice = page.getByTestId("model-recommendation");
  await expect(notice).toContainText(
    m.settings.models.recommendation(m.languageName[other], ui.models[RECOMMENDED[other]].name),
  );
  await expect(notice.getByRole("button", { name: m.common.download })).toBeEnabled();
  await snap("settings-models-speech-changed");
});

test("推奨の案内: 推奨が未取得ならダウンロードを始め、取得中は終わるまで待つよう示す", { tag: I18N }, async ({ page, m, ui, appLocale }) => {
  await open(page, "models-not-recommended");
  const rec = RECOMMENDED[appLocale];
  const notice = page.getByTestId("model-recommendation");
  await expect(notice).toContainText(m.settings.models.recommendation(m.languageName[appLocale], ui.models[rec].name));
  await notice.getByRole("button", { name: m.common.download }).click();
  expect(await calls(page, "download_model")).toEqual([{ cmd: "download_model", args: { id: rec } }]);
  await expect(page.getByTestId(`model-${rec}`)).toHaveAttribute("data-state", "downloading");
  await expect(notice).toContainText(m.settings.models.recommendationDownloading);
  await expect(notice.getByRole("button")).toHaveCount(0);
});

test("推奨の案内: 推奨が取得済みなら切り替えられ、切り替えると案内は消える", async ({ page, m, appLocale }) => {
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await open(page, "models-not-recommended-downloaded");
  const rec = RECOMMENDED[appLocale];
  const notice = page.getByTestId("model-recommendation");
  await notice.getByRole("button", { name: m.settings.models.switchTo }).click();
  expect(await calls(page, "select_model")).toEqual([{ cmd: "select_model", args: { id: rec } }]);
  await page.clock.runFor(1000);
  await expect(row(page, rec)).toContainText(m.settings.models.inUse);
  await expect(notice).toHaveCount(0);
});
