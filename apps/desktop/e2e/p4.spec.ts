/*
 * P4 (セットアップ・ストレージ) の確認: provisioning の状態表示・一時停止/再開/再試行・開き直した時の再開、
 * complete_setup の条件、実行環境とモデルの削除、アンインストール。
 */
import { expect, I18N, MESSAGES, test, type Locale } from "./fixtures";
import type { Page } from "@playwright/test";

const SETUP = { width: 640, height: 520 };
const SETTINGS = { width: 840, height: 640 };

type Call = { cmd: string; args: Record<string, unknown> };
type Size = { width: number; height: number };

async function open(page: Page, query: string, viewport: Size) {
  await page.setViewportSize(viewport);
  await page.goto(`/?${query}`);
  // 描画されてから待つ (描画前は同梱フォントの読み込みが始まっておらず、fonts.ready がすぐ解決する)
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0);
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

test("setup: runtime → model → verify と進み、done になってから次へ進める", async ({ page, m }) => {
  // モックの進行 (250ms ごと) を clock で進める。実時間だと遅い CI では確認する前に次の段階へ進んでしまう
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await open(page, "window=setup&mock=download-live", SETUP);
  const next = page.getByRole("button", { name: m.common.next });
  // 未開始なら開始する
  await expect.poll(async () => (await calls(page, "start_provisioning")).length).toBe(1);
  // runtime は大きさを出さない
  await expect(item(page, "runtime")).toContainText(m.setup.download.runningRuntime);
  await expect(page.getByText(m.setup.download.preparingRuntime)).toBeVisible();
  await expect(next).toBeDisabled();
  // model はバイト数、全体も model のみ (runtime は約 1 秒)
  await page.clock.runFor(1000);
  await expect(item(page, "runtime")).toContainText(m.setup.download.done);
  await page.clock.runFor(250);
  await expect(item(page, "model")).toContainText(/\d\.\d \/ 2\.4 GB/);
  // 全体は 1 GB 未満なら MB で出すので、1 GB を超えるまで進める (model は 0.1 GB / 250ms)
  await page.clock.runFor(2250);
  await expect(page.getByText(/GB \/ 2\.4 GB/)).toBeVisible();
  // verify
  await page.clock.runFor(3750);
  await expect(item(page, "verify")).toContainText(m.setup.download.runningVerify);
  await expect(next).toBeDisabled();
  await page.clock.runFor(1000);
  await expect(item(page, "verify")).toHaveAttribute("data-state", "done");
  await expect(next).toBeEnabled();
  await expect(page.getByText(m.setup.download.titleDone)).toBeVisible();
});

test("setup: 一時停止は止まるまで押せず、止まった項目は active のまま。再開で続きから進む", async ({ page, m }) => {
  // モックの進行 (250ms ごと) と一時停止の応答 (300ms) を clock で進める
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await open(page, "window=setup&mock=download-live", SETUP);
  await expect.poll(async () => (await calls(page, "start_provisioning")).length).toBe(1);
  // runtime (約 1 秒) の後に model へ進み、取得が進む
  await page.clock.runFor(1500);
  await expect(item(page, "model")).toHaveAttribute("data-state", "active");
  await expect.poll(() => modelBytes(page)).toBeGreaterThan(0);
  const pause = page.getByRole("button", { name: m.common.pause });
  await pause.click();
  // pause_provisioning が返るまで (止まるまで) は押せない
  await expect(pause).toBeDisabled();
  await expect(page.getByText(m.setup.download.titleRunning)).toBeVisible();
  await page.clock.runFor(300);
  await expect(page.getByText(m.setup.download.titlePaused)).toBeVisible();
  await expect(item(page, "model")).toHaveAttribute("data-state", "active");
  await expect(page.getByText(m.setup.download.paused, { exact: false }).first()).toBeVisible();
  const before = await modelBytes(page);
  await page.getByRole("button", { name: m.common.resume }).click();
  await expect.poll(async () => (await calls(page, "start_provisioning")).length).toBe(2);
  await expect(page.getByText(m.setup.download.titleRunning)).toBeVisible();
  // 続きから (取得済みの量から減らずに進む)
  expect(await modelBytes(page)).toBeGreaterThanOrEqual(before);
  await page.clock.runFor(250);
  expect(await modelBytes(page)).toBeGreaterThan(before);
});

test("setup: 失敗したら表示用の文言を出し、再試行は start_provisioning", async ({ page, m, ui }) => {
  // 再試行後の取得中の表示を確かめる間に導入が終わらないよう時計を止める
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await open(page, "window=setup&mock=download-error", SETUP);
  await expect(page.getByRole("alert")).toContainText(ui.modelDownloadFailed);
  await expect(item(page, "model")).toHaveAttribute("data-state", "active");
  await expect(page.getByRole("button", { name: m.common.pause })).toBeDisabled();
  await page.getByRole("button", { name: m.common.retry }).click();
  await expect.poll(async () => (await calls(page, "start_provisioning")).length).toBe(1);
  await expect(page.getByText(m.setup.download.titleRunning)).toBeVisible();
});

test("setup: runtime の失敗では取得済みの量を出さない", async ({ page, m, ui }) => {
  await open(page, "window=setup&mock=download-error-runtime", SETUP);
  await expect(page.getByRole("alert")).toContainText(ui.runtimeFailed);
  await expect(page.getByRole("alert")).not.toContainText(m.setup.download.resumeFrom("0.9 GB").trim());
});

test("setup: 導入の途中で開き直したらダウンロードのステップから現在の状態で再開する", async ({ page, m }) => {
  await open(page, "window=setup&mock=resume", SETUP);
  await expect(page.getByText(m.setup.download.titlePaused)).toBeVisible();
  await expect(page.getByText(`0.9 GB / 2.4 GB${m.common.separator}${m.setup.download.paused}`)).toBeVisible();
  // 一時停止中は自動で開始しない
  expect(await calls(page, "start_provisioning")).toHaveLength(0);
});

test("setup: 導入が済むまで complete_setup を呼ばない", async ({ page, m }) => {
  await open(page, "window=setup&mock=done", SETUP);
  const closeButton = page.getByRole("button", { name: m.common.close });
  await expect(closeButton).toBeEnabled();
  await mock(page, `api.db.provisioning = { ...api.db.provisioning, stage: "verify" }; api.fire("provisioning-progress", api.db.provisioning);`);
  await expect(closeButton).toBeDisabled();
  await mock(page, `api.db.provisioning = { ...api.db.provisioning, stage: "done" }; api.fire("provisioning-progress", api.db.provisioning);`);
  await closeButton.click();
  await expect.poll(async () => (await calls(page, "complete_setup")).length).toBe(1);
});

test("setup: complete_setup の失敗を表示する", async ({ page, m }) => {
  await open(page, "window=setup&mock=done", SETUP);
  await mock(page, `api.fail.complete_setup = "セットアップを完了できませんでした";`);
  await page.getByRole("button", { name: m.common.close }).click();
  await expect(page.getByRole("alert")).toContainText("セットアップを完了できませんでした");
});

// ---------- セットアップ: ようこそ (言語) ----------

const OTHER: Record<Locale, Locale> = { ja: "en", en: "ja" };
const RECOMMENDED: Record<Locale, string> = { ja: "ja-8bit", en: "base-1.7b-8bit" };

function selectedModelId(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () =>
      (window as unknown as { __mukuchiMock: { db: { models: { id: string; selected: boolean }[] } } }).__mukuchiMock.db.models.find(
        (x) => x.selected,
      )?.id,
  );
}

test("setup: 表示言語を選ぶとすぐにその言語に切り替わり、uiLanguage を保存する", { tag: I18N }, async ({ page, m, appLocale }) => {
  await open(page, "window=setup&mock=default", SETUP);
  await expect(page.getByText(m.setup.welcome.title)).toBeVisible();
  const other = OTHER[appLocale];
  await page.getByTestId("ui-language").selectOption(other);
  await expect(page.getByText(MESSAGES[other].setup.welcome.title)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", other);
  await expect(page.getByTestId("ui-language")).toHaveValue(other);
  expect((await calls(page, "update_settings")).map((c) => c.args.patch)).toContainEqual({ uiLanguage: other });
});

// 推奨モデルは話す言語で違う
test("setup: 取得前に話す言語を変えると、取得するモデルがその言語の推奨になる", { tag: I18N }, async ({ page, m, appLocale }) => {
  await open(page, "window=setup&mock=default", SETUP);
  const speech = page.getByTestId("speech-language");
  await expect(speech).toHaveValue(appLocale);
  // 取得前は変えられ、理由は出さない
  await expect(speech).toBeEnabled();
  await expect(page.getByTestId("speech-language-locked")).toHaveCount(0);
  expect(await selectedModelId(page)).toBe(RECOMMENDED[appLocale]);
  const other = OTHER[appLocale];
  await speech.selectOption(other);
  await expect(speech).toHaveValue(other);
  expect((await calls(page, "update_settings")).map((c) => c.args.patch)).toContainEqual({ speechLanguage: other });
  await expect.poll(() => selectedModelId(page)).toBe(RECOMMENDED[other]);
  // 容量は取得するモデル (推奨) の sizeBytes。どちらも約 2.2 GB
  await expect(page.getByTestId("welcome-download")).toHaveText(m.setup.welcome.downloadWithSize("2.2 GB"));
  // 表示言語は変わらない
  await expect(page.getByText(m.setup.welcome.title)).toBeVisible();
});

test("setup: 取得を始めた後・準備の実行中は話す言語を変えられず、それぞれの理由を出す", async ({ page, m }) => {
  for (const [mock, reason, text] of [
    ["welcome-locked", "started", m.setup.welcome.speechLanguageLocked],
    ["welcome-running", "running", m.setup.welcome.speechLanguageLockedRunning],
  ] as const) {
    await open(page, `window=setup&mock=${mock}`, SETUP);
    await expect(page.getByText(m.setup.welcome.title)).toBeVisible();
    await expect(page.getByTestId("speech-language")).toBeDisabled();
    const locked = page.getByTestId("speech-language-locked");
    await expect(locked).toHaveText(text);
    await expect(locked).toHaveAttribute("data-reason", reason);
    // 表示言語は変えられる
    await expect(page.getByTestId("ui-language")).toBeEnabled();
  }
});

test("setup: 準備の実行中に話す言語が変わってもモデルの選択は変えない (Rust と同じ条件)", async ({ page }) => {
  await open(page, "window=setup&mock=welcome-running", SETUP);
  const selectedBefore = await page.evaluate(`window.__mukuchiMock.db.models.find((m) => m.selected).id`);
  await page.evaluate(`(() => {
    const api = window.__mukuchiMock;
    const next = api.db.settings.speechLanguage === "ja" ? "en" : "ja";
    return api.invoke("update_settings", { patch: { speechLanguage: next } });
  })()`);
  expect(await page.evaluate(`window.__mukuchiMock.db.models.find((m) => m.selected).id`)).toBe(selectedBefore);
});

// ---------- 設定: ストレージ ----------

test("settings: 実行環境とモデルを削除すると使用量を取り直し、セットアップへの案内を出す", async ({ page, m }) => {
  await open(page, "window=settings&mock=default&category=storage", SETTINGS);
  await expect(page.getByText("3.4 GB")).toBeVisible();
  await expect(page.getByTestId("runtime-missing")).toHaveCount(0);
  await page.getByRole("button", { name: m.common.delete, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: m.common.delete, exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await calls(page, "delete_runtime_and_model")).toHaveLength(1);
  await expect(page.getByTestId("runtime-missing")).toBeVisible();
  await expect(page.getByText("12 MB").first()).toBeVisible();
  await expect(page.getByRole("button", { name: m.common.delete, exact: true })).toBeDisabled();
  await page.getByRole("button", { name: m.common.openSetup }).click();
  await expect.poll(async () => (await calls(page, "open_setup")).length).toBe(1);
});

test("settings: 削除に失敗したらダイアログにメッセージを出す", async ({ page, m }) => {
  await open(page, "window=settings&mock=default&category=storage", SETTINGS);
  await mock(page, `api.fail.delete_runtime_and_model = "モデルを削除できませんでした";`);
  await page.getByRole("button", { name: m.common.delete, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: m.common.delete, exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("モデルを削除できませんでした");
});

test("settings: 使用量を取得できなければエラーを出す", async ({ page, m }) => {
  await page.setViewportSize(SETTINGS);
  await page.goto("/?window=settings&mock=default&category=general");
  await page.waitForFunction(() => "__mukuchiMock" in window);
  await mock(page, `api.fail.get_storage_usage = "使用量を計算できませんでした";`);
  await page.getByRole("button", { name: m.settings.categories.storage }).click();
  await expect(page.getByRole("alert")).toContainText("使用量を計算できませんでした");
  await expect(page.getByText("—")).toBeVisible();
});

test("settings: アンインストール中は取り消せず、終わるまで操作できない", async ({ page, m }) => {
  // モックのアンインストールは 800ms で終わる。実時間だと遅い CI (並列実行) では確かめる前に終わるため時計を止める
  await page.clock.install();
  await open(page, "window=settings&mock=default&category=storage", SETTINGS);
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1000);
  await page.getByRole("button", { name: m.settings.storage.uninstallEllipsis }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(m.settings.storage.uninstallTotal("3.7 GB"))).toBeVisible();
  await dialog.getByRole("button", { name: m.settings.storage.uninstallButton, exact: true }).click();
  await expect(dialog.getByText(m.settings.storage.uninstallRunning.macos)).toBeVisible();
  await expect(dialog.getByRole("button", { name: m.common.cancel })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: m.settings.storage.uninstallButton, exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.clock.runFor(800);
  // モックは dry run と同じく終了せずに返る
  await expect(dialog.getByText(m.settings.storage.uninstallDone)).toBeVisible();
  expect(await calls(page, "uninstall")).toHaveLength(1);
});

test("settings: アンインストールに失敗したらダイアログにメッセージを出して閉じられる", async ({ page, m }) => {
  await open(page, "window=settings&mock=default&category=storage", SETTINGS);
  await mock(page, `api.fail.uninstall = "アプリ本体をゴミ箱に入れられませんでした";`);
  await page.getByRole("button", { name: m.settings.storage.uninstallEllipsis }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: m.settings.storage.uninstallButton, exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("アプリ本体をゴミ箱に入れられませんでした");
  await dialog.getByRole("button", { name: m.common.cancel }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("settings: 削除対象を取得できなければアンインストールさせない", async ({ page, m }) => {
  await open(page, "window=settings&mock=default&category=storage", SETTINGS);
  await mock(page, `api.fail.get_uninstall_targets = "削除対象を確認できませんでした";`);
  await page.getByRole("button", { name: m.settings.storage.uninstallEllipsis }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("alert")).toHaveText("削除対象を確認できませんでした");
  await expect(dialog.getByRole("button", { name: m.settings.storage.uninstallButton, exact: true })).toBeDisabled();
});
