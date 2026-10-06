/*
 * 全画面・全状態をモックで開き、主要な文言が出ることを確認する (表示言語ごと。playwright.config.ts の projects)。
 * スクリーンショットは e2e/screenshots/<言語>/ (git 管理外) に保存し、デザインとの目視比較に使う。
 */
import { expect, test, type Messages } from "./fixtures";
import type { Page } from "@playwright/test";
import type { MockSpeechTexts, MockUiTexts } from "../src/mock/texts";

/** recName: 話す言語の推奨モデル (新規の設定で選択中) の表示名 */
type Texts = (m: Messages, ui: MockUiTexts, sp: MockSpeechTexts, recName: string) => string[];

type Case = {
  name: string;
  query: string;
  texts: Texts;
  viewport: { width: number; height: number };
  dark?: boolean;
};

const PANEL = { width: 560, height: 260 };
const SETUP = { width: 640, height: 520 };
const SETTINGS = { width: 840, height: 640 };

const cases: Case[] = [
  // ---- パネル (03 / 06) ----
  { name: "panel-off", query: "window=panel&mock=off", texts: (m) => [m.panel.turnOn], viewport: PANEL },
  { name: "panel-loading", query: "window=panel&mock=loading", texts: (m) => [`${m.panel.loadingModel} 64%`], viewport: PANEL },
  { name: "panel-idle", query: "window=panel&mock=idle", texts: (m) => [m.panel.idle], viewport: PANEL },
  { name: "panel-speaking", query: "window=panel&mock=speaking", texts: (m, _, sp) => [sp.partial, m.panel.speaking], viewport: PANEL },
  { name: "panel-finalizing", query: "window=panel&mock=finalizing", texts: (m, _, sp) => [sp.text, m.panel.finalizing], viewport: PANEL },
  { name: "panel-inserted", query: "window=panel&mock=inserted", texts: (_, __, sp) => [sp.text], viewport: PANEL },
  { name: "panel-command", query: "window=panel&mock=command", texts: (m, _, sp) => [sp.command, "Enter", m.panel.command], viewport: PANEL },
  { name: "panel-excluded", query: "window=panel&mock=excluded", texts: (m, _, sp) => [sp.text, m.panel.excluded("1Password")], viewport: PANEL },
  { name: "panel-failed", query: "window=panel&mock=failed", texts: (_, ui) => [ui.insertFailedNoAccessibility], viewport: PANEL },
  { name: "panel-multi", query: "window=panel&mock=multi", texts: (m, _, sp) => [sp.text, sp.secondPartial, m.panel.speaking], viewport: PANEL },
  { name: "panel-overflow", query: "window=panel&mock=overflow", texts: (m) => [m.panel.speaking], viewport: PANEL },
  { name: "panel-error-accessibility", query: "window=panel&mock=error-accessibility", texts: (m) => [m.panel.errors.accessibility_denied, m.errorActions.open_accessibility], viewport: PANEL },
  { name: "panel-error-asr", query: "window=panel&mock=error-asr", texts: (m) => [m.panel.errors.asr_stopped, m.errorActions.restart_asr], viewport: PANEL },
  { name: "panel-error-mic", query: "window=panel&mock=error-mic", texts: (m) => [m.panel.errors.microphone_missing, m.errorActions.select_microphone], viewport: PANEL },
  { name: "panel-error-mic-denied", query: "window=panel&mock=error-mic-denied", texts: (m) => [m.panel.errors.microphone_denied], viewport: PANEL },
  { name: "panel-error-runtime", query: "window=panel&mock=error-runtime", texts: (m) => [m.panel.errors.runtime_missing, m.errorActions.start_setup], viewport: PANEL },
  { name: "panel-off-dark", query: "window=panel&mock=off", texts: (m) => [m.panel.turnOn], viewport: PANEL, dark: true },
  { name: "panel-idle-dark", query: "window=panel&mock=idle", texts: (m) => [m.panel.idle], viewport: PANEL, dark: true },
  { name: "panel-speaking-dark", query: "window=panel&mock=speaking", texts: (m) => [m.panel.speaking], viewport: PANEL, dark: true },

  // ---- セットアップ (04) ----
  {
    name: "setup-1-welcome",
    query: "window=setup&mock=default",
    texts: (m) => [m.setup.welcome.title, m.setup.welcome.downloadWithSize("2.2 GB"), m.setup.welcome.uiLanguage, m.setup.welcome.speechLanguage, m.setup.welcome.start],
    viewport: SETUP,
  },
  { name: "setup-1-welcome-running", query: "window=setup&mock=welcome-running", texts: (m) => [m.setup.welcome.speechLanguageLockedRunning], viewport: SETUP },
  { name: "setup-1-welcome-locked", query: "window=setup&mock=welcome-locked", texts: (m) => [m.setup.welcome.speechLanguageLocked], viewport: SETUP },
  { name: "setup-2-permissions", query: "window=setup&mock=permissions", texts: (m) => [m.setup.permissions.title, m.common.granted, m.common.notGranted, m.common.openSystemSettings], viewport: SETUP },
  { name: "setup-2-permissions-mic-denied", query: "window=setup&mock=permissions-denied", texts: (m) => [m.setup.permissions.guideMicDenied], viewport: SETUP },
  { name: "setup-2-permissions-mic-not-determined", query: "window=setup&mock=default&step=2", texts: (m) => [m.setup.permissions.guideMicNotDetermined, m.common.allow], viewport: SETUP },
  { name: "setup-2-permissions-granted", query: "window=setup&mock=permissions-granted", texts: (m) => [m.setup.permissions.title], viewport: SETUP },
  {
    name: "setup-3-download",
    query: "window=setup&mock=download",
    texts: (m, _, __, recName) => [
      m.setup.download.titleRunning,
      `0.9 GB / 2.4 GB${m.common.separator}${m.format.etaMinutes(3)}`,
      m.setup.download.runtime,
      // 取得するモデルの名前 (Rust の ModelInfo.name)
      recName,
      "0.9 / 2.4 GB",
      m.setup.download.pending,
    ],
    viewport: SETUP,
  },
  { name: "setup-3-download-runtime", query: "window=setup&mock=download-runtime", texts: (m) => [m.setup.download.preparingRuntime, m.setup.download.runningRuntime], viewport: SETUP },
  { name: "setup-3-download-eta-unknown", query: "window=setup&mock=download-eta-unknown", texts: (m) => [m.setup.download.etaCalculating], viewport: SETUP },
  { name: "setup-3-download-verify", query: "window=setup&mock=download-verify", texts: (m) => [`2.4 GB / 2.4 GB${m.common.separator}${m.setup.download.verifying}`, m.setup.download.runningVerify], viewport: SETUP },
  {
    name: "setup-3-download-error",
    query: "window=setup&mock=download-error",
    texts: (m, ui) => [m.setup.download.titleFailed, ui.modelDownloadFailed, m.setup.download.resumeFrom("0.9 GB").trim(), m.common.retry],
    viewport: SETUP,
  },
  { name: "setup-3-download-error-runtime", query: "window=setup&mock=download-error-runtime", texts: (m, ui) => [ui.runtimeFailed, m.setup.download.failed, m.common.retry], viewport: SETUP },
  { name: "setup-3-download-paused", query: "window=setup&mock=download-paused", texts: (m) => [m.setup.download.titlePaused, `0.9 GB / 2.4 GB${m.common.separator}${m.setup.download.paused}`, m.common.resume], viewport: SETUP },
  { name: "setup-3-download-done", query: "window=setup&mock=download-done", texts: (m) => [m.setup.download.titleDone], viewport: SETUP },
  {
    name: "setup-4-input-mode",
    query: "window=setup&mock=input-mode",
    texts: (m) => [
      m.setup.inputMode.title,
      m.inputMode.continuous.label,
      m.inputMode.oneShot.label,
      m.setup.inputMode.useCases,
      m.inputMode.continuous.useCases[0],
      m.shortcut.label,
      m.inputMode.shortcutHint.continuous,
    ],
    viewport: SETUP,
  },
  { name: "setup-4-input-mode-oneshot", query: "window=setup&mock=input-mode-oneshot", texts: (m) => [m.inputMode.oneShot.useCases[0], m.inputMode.shortcutHint.oneShot], viewport: SETUP },
  { name: "setup-4-input-mode-conflict", query: "window=setup&mock=input-mode-conflict", texts: (_, ui) => [ui.shortcutConflict("⌥ Space")], viewport: SETUP },
  { name: "setup-5-test", query: "window=setup&mock=test", texts: (m) => [m.setup.test.title, m.setup.test.sentKey("Enter"), m.setup.test.recognized], viewport: SETUP },
  { name: "setup-5-test-oneshot", query: "window=setup&mock=test-oneshot", texts: (m) => [m.setup.test.title], viewport: SETUP },
  { name: "setup-6-done", query: "window=setup&mock=done", texts: (m) => [m.setup.done.title, m.setup.done.launchAtLogin, m.common.close], viewport: SETUP },
  { name: "setup-6-done-oneshot", query: "window=setup&mock=done-oneshot", texts: (m) => [m.setup.done.title], viewport: SETUP },
  { name: "setup-1-welcome-dark", query: "window=setup&mock=default", texts: (m) => [m.setup.welcome.title], viewport: SETUP, dark: true },
  { name: "setup-2-permissions-dark", query: "window=setup&mock=permissions", texts: (m) => [m.setup.permissions.title], viewport: SETUP, dark: true },
  { name: "setup-4-input-mode-dark", query: "window=setup&mock=input-mode-oneshot", texts: (m) => [m.setup.inputMode.title], viewport: SETUP, dark: true },

  // ---- 設定 (05) ----
  {
    name: "settings-general",
    query: "window=settings&mock=default&category=general",
    texts: (m) => [m.settings.categories.general, m.settings.general.language, m.settings.general.uiLanguage, m.settings.general.behavior, m.settings.general.launchAtLogin, m.settings.general.panel, m.settings.general.compact],
    viewport: SETTINGS,
  },
  {
    name: "settings-voice",
    query: "window=settings&mock=default&category=voice",
    texts: (m) => [
      m.inputMode.groupLabel,
      m.inputMode.continuous.label,
      m.inputMode.oneShot.label,
      m.shortcut.label,
      m.settings.voice.microphone,
      m.settings.voice.inputLevel,
      m.settings.voice.sensitivity,
      m.format.seconds("1.3"),
      m.settings.voice.excludedApps,
      "1Password",
      m.settings.voice.addApp,
    ],
    viewport: SETTINGS,
  },
  { name: "settings-voice-shortcut-conflict", query: "window=settings&mock=shortcut-conflict&category=voice", texts: (_, ui) => [ui.shortcutConflict("⌥ Space")], viewport: SETTINGS },
  {
    name: "settings-commands",
    query: "window=settings&mock=default&category=commands",
    texts: (m, _, sp) => [m.settings.commands.enable, sp.voiceCommands[0].phrases[0], "Shift + Enter", "⌘ + Enter", m.settings.commands.add],
    viewport: SETTINGS,
  },
  {
    name: "settings-recognition",
    query: "window=settings&mock=default&category=recognition",
    texts: (m, _, __, recName) => [recName, m.settings.recognition.loaded, m.settings.recognition.speechLanguage, m.settings.models.recommended, m.settings.recognition.context, "/ 1000"],
    viewport: SETTINGS,
  },
  {
    name: "settings-recognition-not-recommended",
    query: "window=settings&mock=models-not-recommended&category=recognition",
    texts: (m) => [m.common.download],
    viewport: SETTINGS,
  },
  {
    name: "settings-recognition-not-recommended-downloaded",
    query: "window=settings&mock=models-not-recommended-downloaded&category=recognition",
    texts: (m) => [m.settings.models.switchTo],
    viewport: SETTINGS,
  },
  { name: "settings-recognition-stopped", query: "window=settings&mock=asr-stopped&category=recognition", texts: (m) => [m.settings.recognition.stopped, m.common.restart], viewport: SETTINGS },
  { name: "settings-permissions", query: "window=settings&mock=perm-denied&category=permissions", texts: (m) => [m.settings.permissions.accessibility, m.common.notGranted, m.common.openSystemSettings], viewport: SETTINGS },
  { name: "settings-permissions-mic-not-determined", query: "window=settings&mock=mic-not-determined&category=permissions", texts: (m) => [m.settings.permissions.micNotDetermined], viewport: SETTINGS },
  { name: "settings-storage", query: "window=settings&mock=default&category=storage", texts: (m) => ["3.4 GB", m.settings.storage.used, m.settings.storage.models, "12 MB", m.settings.storage.uninstall], viewport: SETTINGS },
  { name: "settings-storage-runtime-missing", query: "window=settings&mock=runtime-missing&category=storage", texts: (m) => ["12 MB", m.settings.storage.runtimeMissing, m.common.openSetup], viewport: SETTINGS },
  {
    name: "settings-about",
    query: "window=settings&mock=default&category=about",
    texts: (m) => ["mukuchi", m.settings.about.version("0.1.0", "42"), m.settings.about.upToDate, m.settings.about.check, m.settings.about.autoCheck, m.settings.about.license, m.settings.about.openInFinder],
    viewport: SETTINGS,
  },
  { name: "settings-about-update-unchecked", query: "window=settings&mock=update-unchecked&category=about", texts: (m) => [m.settings.about.notChecked, m.settings.about.current("v0.1.0")], viewport: SETTINGS },
  { name: "settings-about-update-unavailable", query: "window=settings&mock=update-unavailable&category=about", texts: (m, ui) => [m.settings.about.unavailable, ui.updateUnavailable], viewport: SETTINGS },
  { name: "settings-about-update-checking", query: "window=settings&mock=update-checking&category=about", texts: (m) => [m.settings.about.checking], viewport: SETTINGS },
  { name: "settings-about-update-downloading", query: "window=settings&mock=update-downloading&category=about", texts: (m) => [m.settings.about.downloading("v0.2.0"), "14 / 40 MB"], viewport: SETTINGS },
  {
    name: "settings-about-update-ready",
    query: "window=settings&mock=update-ready&category=about",
    texts: (m, ui) => [m.settings.about.ready("v0.2.0"), m.settings.about.readySub("v0.1.0"), ui.updateNotes.split("\n")[0].slice(2), m.settings.about.install],
    viewport: SETTINGS,
  },
  { name: "settings-about-update-installing", query: "window=settings&mock=update-installing&category=about", texts: (m) => [m.settings.about.installing("v0.2.0"), m.settings.about.installingSub], viewport: SETTINGS },
  { name: "settings-about-update-error", query: "window=settings&mock=update-error&category=about", texts: (m, ui) => [m.settings.about.failed(null), ui.updateError], viewport: SETTINGS },
  { name: "settings-about-update-ready-dark", query: "window=settings&mock=update-ready&category=about", texts: (m) => [m.settings.about.ready("v0.2.0")], viewport: SETTINGS, dark: true },
  { name: "settings-about-dark", query: "window=settings&mock=default&category=about", texts: (m) => [m.settings.about.license], viewport: SETTINGS, dark: true },
  { name: "settings-voice-dark", query: "window=settings&mock=default&category=voice", texts: (m) => [m.settings.voice.sensitivity], viewport: SETTINGS, dark: true },
  { name: "settings-commands-dark", query: "window=settings&mock=default&category=commands", texts: (m) => [m.settings.commands.enable], viewport: SETTINGS, dark: true },
  { name: "settings-recognition-dark", query: "window=settings&mock=models-not-recommended&category=recognition", texts: (m) => [m.settings.recognition.speechLanguage], viewport: SETTINGS, dark: true },
];

async function open(page: Page, c: Pick<Case, "query" | "viewport" | "dark">) {
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
  test(c.name, async ({ page, m, ui, sp, shot, appLocale }) => {
    await open(page, c);
    await expect(page.locator("html")).toHaveAttribute("lang", appLocale);
    const recName = ui.models[appLocale === "ja" ? "ja-8bit" : "base-1.7b-8bit"].name;
    for (const t of c.texts(m, ui, sp, recName)) {
      await expect(page.getByText(t, { exact: false }).first()).toBeVisible();
    }
    await page.screenshot({ path: shot(c.name) });
  });
}

test("settings: 権限未許可でサイドバーに黄色の点", async ({ page }) => {
  await open(page, { query: "window=settings&mock=perm-denied", viewport: SETTINGS });
  await expect(page.getByTestId("permissions-warning")).toBeVisible();
});

test("settings: 権限が揃っていれば黄色の点は出ない", async ({ page, m }) => {
  await open(page, { query: "window=settings&mock=default", viewport: SETTINGS });
  await expect(page.getByText(m.settings.general.launchAtLogin)).toBeVisible();
  await expect(page.getByTestId("permissions-warning")).toHaveCount(0);
});

test("settings: サイドバーでカテゴリを切り替える", async ({ page, m }) => {
  await open(page, { query: "window=settings&mock=default", viewport: SETTINGS });
  await page.getByRole("button", { name: m.settings.categories.commands }).click();
  await expect(page.getByText(m.settings.commands.enable)).toBeVisible();
  await page.getByRole("button", { name: m.settings.categories.storage }).click();
  await expect(page.getByText(m.settings.storage.deleteRuntime)).toBeVisible();
});

test("settings: アンインストールの確認ダイアログに実パスを表示", async ({ page, m, shot }) => {
  await open(page, { query: "window=settings&mock=default&category=storage", viewport: SETTINGS });
  await page.getByRole("button", { name: m.settings.storage.uninstallEllipsis }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(m.settings.storage.uninstallTitle)).toBeVisible();
  await expect(dialog.getByText("/Users/you/Library/Application Support/com.minimalcorp.mukuchi")).toBeVisible();
  await expect(dialog.getByText("/Applications/mukuchi.app")).toBeVisible();
  await expect(dialog.getByText(m.settings.storage.uninstallCount(6))).toBeVisible();
  await page.screenshot({ path: shot("settings-uninstall-dialog") });
  await dialog.getByRole("button", { name: m.common.cancel }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("settings: 音声コマンドを追加する", async ({ page, m, shot }) => {
  await open(page, { query: "window=settings&mock=default&category=commands", viewport: SETTINGS });
  await page.getByRole("button", { name: m.settings.commands.add }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(m.settings.commands.phrases).fill(`タブ${m.settings.commands.phraseJoiner}次へ`);
  await dialog.getByLabel(m.settings.commands.keyName, { exact: true }).selectOption("tab");
  await page.screenshot({ path: shot("settings-command-dialog") });
  await dialog.getByRole("button", { name: m.common.save }).click();
  await expect(page.getByText("タブ", { exact: true })).toBeVisible();
  await expect(page.getByText("Tab", { exact: true })).toBeVisible();
});

test("settings: 入力しないアプリを追加・削除する", async ({ page, m }) => {
  await open(page, { query: "window=settings&mock=default&category=voice", viewport: SETTINGS });
  await page.getByRole("button", { name: m.settings.voice.addApp }).click();
  await page.getByRole("menuitem", { name: "Slack" }).click();
  await expect(page.getByText("Slack", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: m.settings.voice.removeApp("Slack") }).click();
  await expect(page.getByText("Slack", { exact: true })).toHaveCount(0);
});

test("settings: 認識のヒントを編集する", async ({ page, m }) => {
  await open(page, { query: "window=settings&mock=default&category=recognition", viewport: SETTINGS });
  const field = page.getByLabel(m.settings.recognition.context);
  await expect(field).toHaveValue(/Claude Code/);
  await field.fill("会議の話です");
  await expect(page.getByText("6 / 1000")).toBeVisible();
  await field.blur();
  await expect(field).toHaveValue("会議の話です");
});

test("setup: 権限が揃うまで次へは押せず、許可すると進める", async ({ page, m }) => {
  await open(page, { query: "window=setup&mock=permissions", viewport: SETUP });
  const nextButton = page.getByRole("button", { name: m.common.next });
  await expect(nextButton).toBeDisabled();
  await page.getByRole("button", { name: m.common.openSystemSettings }).click();
  // モックは 1.5 秒後に許可済みになり、1 秒ごとの再取得で反映される
  await expect(nextButton).toBeEnabled({ timeout: 5000 });
  await nextButton.click();
  await expect(page.getByText(m.setup.download.titleDone)).toBeVisible();
});

test("setup: ダウンロードが進み完了すると次へ進める", async ({ page, m }) => {
  await open(page, { query: "window=setup&mock=download-live", viewport: SETUP });
  await expect(page.getByText(m.setup.download.titleRunning)).toBeVisible();
  await page.getByRole("button", { name: m.common.pause }).click();
  await expect(page.getByText(m.setup.download.titlePaused)).toBeVisible();
  await page.getByRole("button", { name: m.common.resume }).click();
  await expect(page.getByRole("button", { name: m.common.next })).toBeEnabled({ timeout: 15_000 });
});

test("setup: 動作テストでは欄に入力が入る", async ({ page, m, sp }) => {
  await open(page, { query: "window=setup&mock=test", viewport: SETUP });
  await expect(page.getByLabel(m.setup.test.field)).toBeFocused();
  await expect(page.getByLabel(m.setup.test.field)).toHaveValue(new RegExp(sp.testSentence.replace(/[.]/g, "\\.")));
});

test("panel: オンにすると発話が流れ、入力後 750ms でピルに戻る", async ({ page, m, sp }) => {
  await open(page, { query: "window=panel&mock=default", viewport: PANEL });
  await page.getByRole("button", { name: m.panel.turnOn }).click();
  await expect(page.getByText(m.panel.idle)).toBeVisible();
  await expect(page.getByText(m.panel.speaking)).toBeVisible({ timeout: 5000 });
  // 入力できた時は成功マークだけを出し、アプリ名の文言は出さない (文言は読み上げ用のみ)
  const status = page.getByRole("status").filter({ hasText: m.panel.inserted });
  await expect(status).toHaveCount(1, { timeout: 10_000 });
  const shownAt = Date.now();
  await expect(page.getByText(sp.notes, { exact: false })).toHaveCount(0);
  await expect(page.getByTestId("preview")).toContainText(sp.text);
  // 750ms 表示してからピル (待機中) に戻る
  await expect(page.getByTestId("panel-card")).toHaveAttribute("data-expanded", "false", { timeout: 2000 });
  expect(Date.now() - shownAt).toBeLessThan(1500);
  await expect(page.getByText(m.panel.idle)).toBeVisible();
  await page.getByRole("button", { name: m.panel.turnOff }).click();
  await expect(page.getByRole("button", { name: m.panel.turnOn })).toBeVisible();
});

test("panel: 入力できた時は成功マークだけを出す", async ({ page, m, sp }) => {
  await open(page, { query: "window=panel&mock=inserted", viewport: PANEL });
  const status = page.getByRole("status").filter({ hasText: m.panel.inserted });
  await expect(status.locator("svg")).toBeVisible();
  await expect(status.locator(".sr-only")).toHaveText(m.panel.inserted);
  await expect(page.getByText(sp.notes, { exact: false })).toHaveCount(0);
});

/** live のシナリオ (結果を時間経過で消す) で、発話の結果を 1 件流して表示時間を測る */
async function resultDuration(page: Page, turnOn: string, result: string, visible: () => Promise<void>) {
  await open(page, { query: "window=panel&mock=default", viewport: PANEL });
  await expect(page.getByRole("button", { name: turnOn })).toBeVisible();
  // 結果を送る直前から測る。表示されたのを確かめてから測ると、遅い CI では確認が遅れた分だけ短く出る
  // (表示時間のタイマーは結果を受け取ってから始まるので、送る直前からなら必ず表示時間以上になる)
  const sentAt = Date.now();
  await page.evaluate(`(() => {
    const api = window.__mukuchiMock;
    api.setStatus({ phase: "listening" });
    api.started(1);
    api.result(${result});
  })()`);
  await visible();
  await expect(page.getByTestId("panel-card")).toHaveAttribute("data-expanded", "false", { timeout: 8000 });
  return Date.now() - sentAt;
}

test("panel: 入力しないアプリの時は理由を 3 秒表示する", async ({ page, m }) => {
  const ms = await resultDuration(
    page,
    m.panel.turnOn,
    `{ kind: "skipped_excluded", id: 1, text: "こんにちは", appName: "1Password" }`,
    () => expect(page.getByRole("status").filter({ hasText: m.panel.excluded("1Password") })).toBeVisible(),
  );
  expect(ms).toBeGreaterThanOrEqual(2950);
  expect(ms).toBeLessThan(6000);
});

test("panel: 入力できなかった時は Rust のメッセージを理由として 3 秒表示する", async ({ page, m, ui }) => {
  const message = ui.insertFailedNoAccessibility;
  const ms = await resultDuration(
    page,
    m.panel.turnOn,
    `{ kind: "failed", id: 1, text: "こんにちは", error: { code: "accessibility_denied", message: ${JSON.stringify(message)}, action: "open_accessibility" } }`,
    () => expect(page.getByRole("status").filter({ hasText: message })).toBeVisible(),
  );
  expect(ms).toBeGreaterThanOrEqual(2950);
  expect(ms).toBeLessThan(6000);
});

test("panel: 入力できた時は成功マークを 750ms 表示する", async ({ page, m, sp }) => {
  const ms = await resultDuration(
    page,
    m.panel.turnOn,
    `{ kind: "inserted", id: 1, text: "こんにちは", appName: ${JSON.stringify(sp.notes)} }`,
    () => expect(page.getByRole("status").filter({ hasText: m.panel.inserted })).toHaveCount(1),
  );
  expect(ms).toBeGreaterThanOrEqual(700);
  expect(ms).toBeLessThan(2500);
});

test("panel: 理由が長くてもメーターを潰さず、文言を省略する", async ({ page }) => {
  await open(page, { query: "window=panel&mock=idle", viewport: PANEL });
  await page.evaluate(`(() => {
    const api = window.__mukuchiMock;
    api.started(1);
    api.result({ kind: "failed", id: 1, text: "こんにちは", error: { code: "insert_failed", message: "${"とても長いエラーの説明".repeat(6)}", action: null } });
  })()`);
  await expect(page.getByTestId("panel-card")).toHaveCSS("width", "360px");
  const meter = await page.getByTestId("level-meter").boundingBox();
  expect(meter!.width).toBeGreaterThanOrEqual(64);
  const card = await page.getByTestId("panel-card").boundingBox();
  const status = await page.getByRole("status").boundingBox();
  expect(status!.x + status!.width).toBeLessThanOrEqual(card!.x + card!.width);
});

test("ロゴタイルに mukuchi のロゴ画像が読み込まれる", async ({ page }) => {
  for (const query of ["window=settings&mock=default&category=about", "window=setup&mock=default"]) {
    await open(page, { query, viewport: query.startsWith("window=setup") ? SETUP : SETTINGS });
    const logo = page.getByRole("img", { name: "mukuchi" });
    await expect(logo).toBeVisible();
    expect(await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  }
});
