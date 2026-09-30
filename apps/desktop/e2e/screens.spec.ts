/*
 * 全画面・全状態をモックで開き、主要な文言が出ることを確認する。
 * スクリーンショットは e2e/screenshots/ (git 管理外) に保存し、デザインとの目視比較に使う。
 */
import { expect, test, type Page } from "@playwright/test";

type Case = {
  name: string;
  query: string;
  texts: string[];
  viewport: { width: number; height: number };
  dark?: boolean;
};

const PANEL = { width: 560, height: 260 };
const SETUP = { width: 640, height: 520 };
const SETTINGS = { width: 840, height: 640 };

const TEXT = "明日の打ち合わせは十時からに変更してください。";

const cases: Case[] = [
  // ---- パネル (03 / 06) ----
  { name: "panel-off", query: "window=panel&mock=off", texts: ["音声入力をオン"], viewport: PANEL },
  { name: "panel-loading", query: "window=panel&mock=loading", texts: ["モデルを読み込んでいます… 64%"], viewport: PANEL },
  { name: "panel-idle", query: "window=panel&mock=idle", texts: ["待機中"], viewport: PANEL },
  { name: "panel-speaking", query: "window=panel&mock=speaking", texts: ["明日の打ち合わせは十時から", "に変更して", "認識中"], viewport: PANEL },
  { name: "panel-finalizing", query: "window=panel&mock=finalizing", texts: [TEXT, "確定しています…"], viewport: PANEL },
  { name: "panel-inserted", query: "window=panel&mock=inserted", texts: [TEXT], viewport: PANEL },
  { name: "panel-command", query: "window=panel&mock=command", texts: ["確定", "Enter", "を送信しました", "音声コマンド"], viewport: PANEL },
  { name: "panel-excluded", query: "window=panel&mock=excluded", texts: [TEXT, "1Password は入力しない設定です"], viewport: PANEL },
  { name: "panel-failed", query: "window=panel&mock=failed", texts: ["アクセシビリティが未許可のため入力できません"], viewport: PANEL },
  { name: "panel-multi", query: "window=panel&mock=multi", texts: [TEXT, "資料は前日までに", "認識中"], viewport: PANEL },
  { name: "panel-overflow", query: "window=panel&mock=overflow", texts: ["認識中"], viewport: PANEL },
  { name: "panel-error-accessibility", query: "window=panel&mock=error-accessibility", texts: ["アクセシビリティが未許可です"], viewport: PANEL },
  { name: "panel-error-asr", query: "window=panel&mock=error-asr", texts: ["文字起こしが停止しました"], viewport: PANEL },
  { name: "panel-error-mic", query: "window=panel&mock=error-mic", texts: ["マイクが見つかりません"], viewport: PANEL },
  { name: "panel-error-runtime", query: "window=panel&mock=error-runtime", texts: ["モデルがありません"], viewport: PANEL },
  { name: "panel-off-dark", query: "window=panel&mock=off", texts: ["音声入力をオン"], viewport: PANEL, dark: true },
  { name: "panel-idle-dark", query: "window=panel&mock=idle", texts: ["待機中"], viewport: PANEL, dark: true },
  { name: "panel-speaking-dark", query: "window=panel&mock=speaking", texts: ["認識中"], viewport: PANEL, dark: true },

  // ---- セットアップ (04) ----
  { name: "setup-1-welcome", query: "window=setup&mock=default", texts: ["mukuchi へようこそ", "実行環境とモデルをダウンロードします", "はじめる"], viewport: SETUP },
  { name: "setup-2-permissions", query: "window=setup&mock=permissions", texts: ["権限を許可してください", "許可済み", "未許可", "システム設定を開く"], viewport: SETUP },
  { name: "setup-2-permissions-mic-denied", query: "window=setup&mock=permissions-denied", texts: ["システム設定のマイクで"], viewport: SETUP },
  { name: "setup-2-permissions-granted", query: "window=setup&mock=permissions-granted", texts: ["権限を許可してください"], viewport: SETUP },
  { name: "setup-3-download", query: "window=setup&mock=download", texts: ["実行環境とモデルをダウンロードしています", "0.9 GB / 2.4 GB ・ 残り約 3 分", "Python 実行環境", "0.9 / 2.4 GB", "待機中"], viewport: SETUP },
  { name: "setup-3-download-runtime", query: "window=setup&mock=download-runtime", texts: ["実行環境を準備しています", "準備しています…"], viewport: SETUP },
  { name: "setup-3-download-eta-unknown", query: "window=setup&mock=download-eta-unknown", texts: ["残り時間を計算しています"], viewport: SETUP },
  { name: "setup-3-download-verify", query: "window=setup&mock=download-verify", texts: ["2.4 GB / 2.4 GB ・ 動作を確認しています", "確認しています…"], viewport: SETUP },
  { name: "setup-3-download-error", query: "window=setup&mock=download-error", texts: ["準備を完了できませんでした", "モデルのダウンロードに失敗しました。", "取得済みの 0.9 GB から再開します。", "再試行"], viewport: SETUP },
  { name: "setup-3-download-error-runtime", query: "window=setup&mock=download-error-runtime", texts: ["実行環境を導入できませんでした。", "失敗", "再試行"], viewport: SETUP },
  { name: "setup-3-download-paused", query: "window=setup&mock=download-paused", texts: ["ダウンロードを一時停止しました", "0.9 GB / 2.4 GB ・ 一時停止中", "再開"], viewport: SETUP },
  { name: "setup-3-download-done", query: "window=setup&mock=download-done", texts: ["実行環境とモデルの準備ができました"], viewport: SETUP },
  { name: "setup-4-test", query: "window=setup&mock=test", texts: ["試しに話してみてください", "Enter を送信", "正しく認識できました。"], viewport: SETUP },
  { name: "setup-5-done", query: "window=setup&mock=done", texts: ["準備ができました", "ログイン時に起動", "閉じる"], viewport: SETUP },
  { name: "setup-1-welcome-dark", query: "window=setup&mock=default", texts: ["mukuchi へようこそ"], viewport: SETUP, dark: true },
  { name: "setup-2-permissions-dark", query: "window=setup&mock=permissions", texts: ["権限を許可してください"], viewport: SETUP, dark: true },

  // ---- 設定 (05) ----
  { name: "settings-general", query: "window=settings&mock=default&category=general", texts: ["一般", "動作", "ログイン時に起動", "パネル", "コンパクト表示"], viewport: SETTINGS },
  { name: "settings-voice", query: "window=settings&mock=default&category=voice", texts: ["マイク", "入力レベル", "発話検出の感度", "1.3 秒", "入力しないアプリ", "1Password", "アプリを追加"], viewport: SETTINGS },
  { name: "settings-commands", query: "window=settings&mock=default&category=commands", texts: ["音声コマンドを使う", "エンター", "Shift + Enter", "⌘ + Enter", "コマンドを追加"], viewport: SETTINGS },
  { name: "settings-recognition", query: "window=settings&mock=default&category=recognition", texts: ["Qwen3-ASR（日本語追加学習）", "読み込み済み", "語彙ヒント", "6 語", "Kubernetes"], viewport: SETTINGS },
  { name: "settings-recognition-stopped", query: "window=settings&mock=asr-stopped&category=recognition", texts: ["停止中", "再起動"], viewport: SETTINGS },
  { name: "settings-permissions", query: "window=settings&mock=perm-denied&category=permissions", texts: ["アクセシビリティ", "未許可", "システム設定を開く"], viewport: SETTINGS },
  { name: "settings-storage", query: "window=settings&mock=default&category=storage", texts: ["3.6 GB", "使用中", "モデル", "12 MB", "完全にアンインストール"], viewport: SETTINGS },
  { name: "settings-storage-runtime-missing", query: "window=settings&mock=runtime-missing&category=storage", texts: ["12 MB", "実行環境とモデルがありません。", "セットアップを開く"], viewport: SETTINGS },
  { name: "settings-about", query: "window=settings&mock=default&category=about", texts: ["mukuchi", "バージョン 0.1.0（build 42）", "ライセンス", "Finder で開く"], viewport: SETTINGS },
  { name: "settings-about-dark", query: "window=settings&mock=default&category=about", texts: ["ライセンス"], viewport: SETTINGS, dark: true },
  { name: "settings-voice-dark", query: "window=settings&mock=default&category=voice", texts: ["発話検出の感度"], viewport: SETTINGS, dark: true },
  { name: "settings-commands-dark", query: "window=settings&mock=default&category=commands", texts: ["音声コマンドを使う"], viewport: SETTINGS, dark: true },
];

async function open(page: Page, c: Case) {
  await page.emulateMedia({ colorScheme: c.dark ? "dark" : "light" });
  await page.setViewportSize(c.viewport);
  await page.goto(`/?${c.query}`);
  // 同梱フォントの読み込みを待ってから比較・撮影する
  // 描画されてから待つ (描画前は同梱フォントの読み込みが始まっておらず、fonts.ready がすぐ解決する)
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0);
  await page.evaluate(() => document.fonts.ready);
  // モックの入力レベル (20Hz) が届くのを待つ
  await page.waitForTimeout(250);
}

for (const c of cases) {
  test(c.name, async ({ page }) => {
    await open(page, c);
    for (const t of c.texts) {
      await expect(page.getByText(t, { exact: false }).first()).toBeVisible();
    }
    await page.screenshot({ path: `e2e/screenshots/${c.name}.png` });
  });
}

test("settings: 権限未許可でサイドバーに黄色の点", async ({ page }) => {
  await open(page, { name: "", query: "window=settings&mock=perm-denied", texts: [], viewport: SETTINGS });
  await expect(page.getByTestId("permissions-warning")).toBeVisible();
});

test("settings: 権限が揃っていれば黄色の点は出ない", async ({ page }) => {
  await open(page, { name: "", query: "window=settings&mock=default", texts: [], viewport: SETTINGS });
  await expect(page.getByText("ログイン時に起動")).toBeVisible();
  await expect(page.getByTestId("permissions-warning")).toHaveCount(0);
});

test("settings: サイドバーでカテゴリを切り替える", async ({ page }) => {
  await open(page, { name: "", query: "window=settings&mock=default", texts: [], viewport: SETTINGS });
  await page.getByRole("button", { name: "音声コマンド" }).click();
  await expect(page.getByText("音声コマンドを使う")).toBeVisible();
  await page.getByRole("button", { name: "ストレージ" }).click();
  await expect(page.getByText("実行環境とモデルのみ削除")).toBeVisible();
});

test("settings: アンインストールの確認ダイアログに実パスを表示", async ({ page }) => {
  const c = { name: "settings-uninstall-dialog", query: "window=settings&mock=default&category=storage", texts: [], viewport: SETTINGS };
  await open(page, c);
  await page.getByRole("button", { name: "アンインストール…" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("mukuchi を完全にアンインストールしますか？")).toBeVisible();
  await expect(dialog.getByText("/Users/you/Library/Application Support/com.minimalcorp.mukuchi")).toBeVisible();
  await expect(dialog.getByText("/Applications/mukuchi.app")).toBeVisible();
  await page.screenshot({ path: `e2e/screenshots/${c.name}.png` });
  await dialog.getByRole("button", { name: "キャンセル" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("settings: 音声コマンドを追加する", async ({ page }) => {
  const c = { name: "settings-command-dialog", query: "window=settings&mock=default&category=commands", texts: [], viewport: SETTINGS };
  await open(page, c);
  await page.getByRole("button", { name: "コマンドを追加" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("言い方").fill("タブ、次へ");
  await dialog.getByLabel("キー", { exact: true }).selectOption("tab");
  await page.screenshot({ path: `e2e/screenshots/${c.name}.png` });
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("タブ", { exact: true })).toBeVisible();
  await expect(page.getByText("Tab", { exact: true })).toBeVisible();
});

test("settings: 入力しないアプリを追加・削除する", async ({ page }) => {
  await open(page, { name: "", query: "window=settings&mock=default&category=voice", texts: [], viewport: SETTINGS });
  await page.getByRole("button", { name: "アプリを追加" }).click();
  await page.getByRole("menuitem", { name: "Slack" }).click();
  await expect(page.getByText("Slack", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Slack を削除" }).click();
  await expect(page.getByText("Slack", { exact: true })).toHaveCount(0);
});

test("settings: 語彙ヒントを追加する", async ({ page }) => {
  await open(page, { name: "", query: "window=settings&mock=default&category=recognition", texts: [], viewport: SETTINGS });
  await page.getByLabel("語彙ヒントに追加する語").fill("無口");
  await page.keyboard.press("Enter");
  await expect(page.getByText("7 語")).toBeVisible();
  await expect(page.getByText("無口", { exact: true })).toBeVisible();
});

test("setup: 権限が揃うまで次へは押せず、許可すると進める", async ({ page }) => {
  await open(page, { name: "", query: "window=setup&mock=permissions", texts: [], viewport: SETUP });
  const nextButton = page.getByRole("button", { name: "次へ" });
  await expect(nextButton).toBeDisabled();
  await page.getByRole("button", { name: "システム設定を開く" }).click();
  // モックは 1.5 秒後に許可済みになり、1 秒ごとの再取得で反映される
  await expect(nextButton).toBeEnabled({ timeout: 5000 });
  await nextButton.click();
  await expect(page.getByText("実行環境とモデル", { exact: false }).first()).toBeVisible();
});

test("setup: ダウンロードが進み完了すると次へ進める", async ({ page }) => {
  await open(page, { name: "", query: "window=setup&mock=download-live", texts: [], viewport: SETUP });
  await expect(page.getByText("実行環境とモデルをダウンロードしています")).toBeVisible();
  await page.getByRole("button", { name: "一時停止" }).click();
  await expect(page.getByText("ダウンロードを一時停止しました")).toBeVisible();
  await page.getByRole("button", { name: "再開" }).click();
  await expect(page.getByRole("button", { name: "次へ" })).toBeEnabled({ timeout: 15_000 });
});

test("setup: 動作テストでは欄に入力が入る", async ({ page }) => {
  await open(page, { name: "", query: "window=setup&mock=test", texts: [], viewport: SETUP });
  await expect(page.getByLabel("テスト入力欄")).toBeFocused();
  await expect(page.getByLabel("テスト入力欄")).toHaveValue(/今日は晴れています。/);
});

test("panel: オンにすると発話が流れ、入力後 750ms でピルに戻る", async ({ page }) => {
  await open(page, { name: "", query: "window=panel&mock=default", texts: [], viewport: PANEL });
  await page.getByRole("button", { name: "音声入力をオン" }).click();
  await expect(page.getByText("待機中")).toBeVisible();
  await expect(page.getByText("認識中")).toBeVisible({ timeout: 5000 });
  // 入力できた時は成功マークだけを出し、アプリ名の文言は出さない (文言は読み上げ用のみ)
  const status = page.getByRole("status").filter({ hasText: "入力しました" });
  await expect(status).toHaveCount(1, { timeout: 10_000 });
  const shownAt = Date.now();
  await expect(page.getByText("に入力しました")).toHaveCount(0);
  await expect(page.getByText("メモ", { exact: false })).toHaveCount(0);
  await expect(page.getByTestId("preview")).toContainText("明日の打ち合わせは十時からに変更してください。");
  // 750ms 表示してからピル (待機中) に戻る
  await expect(page.getByTestId("panel-card")).toHaveAttribute("data-expanded", "false", { timeout: 2000 });
  expect(Date.now() - shownAt).toBeLessThan(1500);
  await expect(page.getByText("待機中")).toBeVisible();
  await page.getByRole("button", { name: "音声入力をオフ" }).click();
  await expect(page.getByRole("button", { name: "音声入力をオン" })).toBeVisible();
});

test("panel: 入力できた時は成功マークだけを出す", async ({ page }) => {
  await open(page, { name: "", query: "window=panel&mock=inserted", texts: [], viewport: PANEL });
  const status = page.getByRole("status").filter({ hasText: "入力しました" });
  await expect(status.locator("svg")).toBeVisible();
  await expect(status.locator(".sr-only")).toHaveText("入力しました");
  await expect(page.getByText("メモ に入力しました")).toHaveCount(0);
});

/** live のシナリオ (結果を時間経過で消す) で、発話の結果を 1 件流して表示時間を測る */
async function resultDuration(page: Page, result: string, visible: () => Promise<void>) {
  await open(page, { name: "", query: "window=panel&mock=default", texts: [], viewport: PANEL });
  await expect(page.getByRole("button", { name: "音声入力をオン" })).toBeVisible();
  await page.evaluate(`(() => {
    const api = window.__mukuchiMock;
    api.setStatus({ phase: "listening" });
    api.started(1);
    api.result(${result});
  })()`);
  await visible();
  const shownAt = Date.now();
  await expect(page.getByTestId("panel-card")).toHaveAttribute("data-expanded", "false", { timeout: 5000 });
  return Date.now() - shownAt;
}

test("panel: 入力しないアプリの時は理由を 3 秒表示する", async ({ page }) => {
  const ms = await resultDuration(
    page,
    `{ kind: "skipped_excluded", id: 1, text: "こんにちは", appName: "1Password" }`,
    () => expect(page.getByRole("status").filter({ hasText: "1Password は入力しない設定です" })).toBeVisible(),
  );
  expect(ms).toBeGreaterThan(2500);
  expect(ms).toBeLessThan(3800);
});

test("panel: 入力できなかった時は Rust のメッセージを理由として 3 秒表示する", async ({ page }) => {
  const ms = await resultDuration(
    page,
    `{ kind: "failed", id: 1, text: "こんにちは", error: { code: "accessibility_denied", message: "アクセシビリティが未許可のため入力できません", action: "open_accessibility" } }`,
    () =>
      expect(page.getByRole("status").filter({ hasText: "アクセシビリティが未許可のため入力できません" })).toBeVisible(),
  );
  expect(ms).toBeGreaterThan(2500);
  expect(ms).toBeLessThan(3800);
});

test("panel: 入力できた時は成功マークを 750ms 表示する", async ({ page }) => {
  const ms = await resultDuration(
    page,
    `{ kind: "inserted", id: 1, text: "こんにちは", appName: "メモ" }`,
    () => expect(page.getByRole("status").filter({ hasText: "入力しました" })).toHaveCount(1),
  );
  expect(ms).toBeLessThan(1500);
});

test("panel: 理由が長くてもメーターを潰さず、文言を省略する", async ({ page }) => {
  await open(page, { name: "", query: "window=panel&mock=idle", texts: [], viewport: PANEL });
  await page.evaluate(`(() => {
    const api = window.__mukuchiMock;
    api.started(1);
    api.result({ kind: "failed", id: 1, text: "こんにちは", error: { code: "insert_failed", message: "${"とても長いエラーの説明".repeat(6)}", action: null } });
  })()`);
  await expect(page.getByTestId("panel-card")).toHaveCSS("width", "440px");
  const meter = await page.getByTestId("level-meter").boundingBox();
  expect(meter!.width).toBeGreaterThanOrEqual(64);
  const card = await page.getByTestId("panel-card").boundingBox();
  const status = await page.getByRole("status").boundingBox();
  expect(status!.x + status!.width).toBeLessThanOrEqual(card!.x + card!.width);
});

test("ロゴタイルに mukuchi のロゴ画像が読み込まれる", async ({ page }) => {
  for (const query of ["window=settings&mock=default&category=about", "window=setup&mock=default"]) {
    await open(page, { name: "", query, texts: [], viewport: query.startsWith("window=setup") ? SETUP : SETTINGS });
    const logo = page.getByRole("img", { name: "mukuchi" });
    await expect(logo).toBeVisible();
    expect(await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  }
});
