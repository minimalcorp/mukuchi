/*
 * Windows の表示 (docs/plans/windows-plan.md §4.3・§5.1)。win-ja / win-en (Chromium) の project でだけ回す (@windows)。
 * OS で変わる文言・キー表記・権限 (マイクのみ)・GPU の判定と CPU 実行の同意を、モック (&platform=windows) で確かめる。
 * pnpm screenshots で e2e/screenshots/windows/<言語>/ に撮る
 */
import { isValidElement, type ReactNode } from "react";
import { expect, SCREENSHOT, test, WINDOWS, type Messages, type PerOs } from "./fixtures";
import { findOverflows } from "./overflow";
import type { Page } from "@playwright/test";
import type { MockUiTexts } from "../src/mock/texts";
import { MOCK_WINDOWS_TEXTS } from "../src/mock/texts";

type Call = { cmd: string; args: Record<string, unknown> };
type Size = { width: number; height: number };
type Os = <T>(value: PerOs<T>) => T;

const PANEL = { width: 560, height: 260 };
const SETUP = { width: 640, height: 520 };
const SETTINGS = { width: 840, height: 640 };

const GPU_NAME = "NVIDIA GeForce RTX 3080 Ti";

/** 辞書の rich な文言の表示テキスト (差し込んだキーは文字列で渡す) */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

async function open(page: Page, query: string, viewport: Size) {
  await page.setViewportSize(viewport);
  await page.goto(`/?${query}`);
  // 描画されてから待つ (描画前は同梱フォントの読み込みが始まっておらず、fonts.ready がすぐ解決する)
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0);
  await page.evaluate(() => document.fonts.ready);
}

function calls(page: Page, cmd: string): Promise<Call[]> {
  return page.evaluate(
    (c) => (window as unknown as { __mukuchiMock: { calls: Call[] } }).__mukuchiMock.calls.filter((x) => x.cmd === c),
    cmd,
  );
}

function patches(page: Page): Promise<Record<string, unknown>[]> {
  return calls(page, "update_settings").then((cs) => cs.map((c) => c.args.patch as Record<string, unknown>));
}

// ---------- 画面ごとの表示 (文言・はみ出し・撮影) ----------

type Case = {
  name: string;
  query: string;
  viewport: Size;
  texts: (m: Messages, os: Os, ui: MockUiTexts, locale: "ja" | "en") => string[];
  /** 出してはいけない文言 (Mac の語・アクセシビリティ) */
  absent?: (m: Messages) => string[];
};

const cases: Case[] = [
  // ---- パネル ----
  { name: "panel-off", query: "window=panel&mock=off", viewport: PANEL, texts: (m) => [m.panel.turnOn] },
  {
    name: "panel-error-gpu",
    query: "window=panel&mock=error-gpu&gpu=none",
    viewport: PANEL,
    texts: (m) => [m.panel.errors.gpu_unavailable, m.errorActions.accept_cpu],
  },
  {
    name: "panel-error-gpu-probe",
    query: "window=panel&mock=error-gpu-probe&gpu=driver_missing",
    viewport: PANEL,
    texts: (m) => [m.panel.errors.gpu_unavailable, m.errorActions.probe_gpu],
  },
  {
    name: "panel-error-mic-denied",
    query: "window=panel&mock=error-mic-denied",
    viewport: PANEL,
    texts: (m, os) => [m.panel.errors.microphone_denied, os(m.errorActions.open_microphone)],
  },

  // ---- セットアップ ----
  {
    name: "setup-1-welcome",
    query: "window=setup&mock=default",
    viewport: SETUP,
    // 話す言語の推奨の GGUF の容量 (ja 約 2.19GB・en 約 2.52GB)
    texts: (m, os, _, locale) => [m.setup.welcome.title, os(m.setup.welcome.privacy), m.setup.welcome.downloadWithSize(locale === "ja" ? "2.2 GB" : "2.5 GB")],
    absent: (m) => [m.setup.welcome.privacy.macos],
  },
  {
    name: "setup-2-permissions",
    query: "window=setup&mock=default&step=2",
    viewport: SETUP,
    texts: (m, os) => [m.setup.permissions.title, os(m.setup.permissions.lead), m.setup.permissions.microphone, os(m.setup.permissions.guideMicNotDetermined), m.common.allow],
    absent: (m) => [m.setup.permissions.accessibility],
  },
  {
    name: "setup-2-permissions-mic-denied",
    query: "window=setup&mock=permissions-denied",
    viewport: SETUP,
    texts: (m, os) => [os(m.setup.permissions.guideMicDenied), os(m.common.openSystemSettings)],
    absent: (m) => [m.setup.permissions.accessibility],
  },
  {
    name: "setup-2-permissions-granted",
    query: "window=setup&mock=permissions-granted",
    viewport: SETUP,
    texts: (m) => [m.setup.permissions.title, m.common.granted],
    absent: (m) => [m.setup.permissions.accessibility],
  },
  {
    name: "setup-3-gpu-none",
    query: "window=setup&mock=default&step=3&gpu=none",
    viewport: SETUP,
    texts: (m) => [m.gpu.noneTitle, m.gpu.noneLead, m.gpu.cpuWarning, m.gpu.noneHint, m.gpu.detect, m.gpu.continueCpu],
  },
  {
    name: "setup-3-gpu-driver",
    query: "window=setup&mock=default&step=3&gpu=driver_missing",
    viewport: SETUP,
    texts: (m) => [m.gpu.driverTitle, m.gpu.driverLead, m.gpu.cpuWarning, m.gpu.driverHint, m.gpu.continueCpu],
  },
  {
    name: "setup-3-download",
    query: "window=setup&mock=download",
    viewport: SETUP,
    texts: (m, os) => [m.setup.download.titleRunning, os(m.setup.download.runtime)],
    absent: (m) => [m.gpu.noneTitle],
  },
  {
    name: "setup-4-input-mode",
    query: "window=setup&mock=input-mode",
    viewport: SETUP,
    texts: (m) => [m.setup.inputMode.title, m.shortcut.label, m.inputMode.shortcutHint.continuous],
  },
  {
    name: "setup-4-input-mode-conflict",
    query: "window=setup&mock=input-mode-conflict",
    viewport: SETUP,
    texts: (_, __, ui) => [ui.shortcutConflict("Alt+Space")],
  },
  {
    name: "setup-6-done-conflict",
    query: "window=setup&mock=done-conflict",
    viewport: SETUP,
    texts: (m) => [m.setup.done.title, m.shortcut.change],
  },
  { name: "setup-5-test-oneshot", query: "window=setup&mock=test-oneshot", viewport: SETUP, texts: (m) => [m.setup.test.title] },
  {
    name: "setup-6-done",
    query: "window=setup&mock=done",
    viewport: SETUP,
    texts: (m, os) => [m.setup.done.title, os(m.setup.done.lead)],
    absent: (m) => [m.setup.done.lead.macos],
  },

  // ---- 設定 ----
  { name: "settings-general", query: "window=settings&mock=default&category=general", viewport: SETTINGS, texts: (m) => [m.settings.general.launchAtLogin] },
  {
    name: "settings-voice",
    query: "window=settings&mock=default&category=voice",
    viewport: SETTINGS,
    texts: (m, _, __, locale) => [m.settings.voice.excludedApps, "1Password", "1password.exe", MOCK_WINDOWS_TEXTS[locale].terminal, "windowsterminal.exe", "Alt"],
  },
  { name: "settings-voice-shortcut-conflict", query: "window=settings&mock=shortcut-conflict&category=voice", viewport: SETTINGS, texts: (_, __, ui) => [ui.shortcutConflict("Alt+Space")] },
  {
    name: "settings-commands",
    query: "window=settings&mock=default&category=commands",
    viewport: SETTINGS,
    texts: (m) => [m.settings.commands.enable, "Shift + Enter", "Ctrl + Enter"],
    absent: () => ["⌘ + Enter"],
  },
  {
    name: "settings-recognition",
    query: "window=settings&mock=default&category=recognition",
    viewport: SETTINGS,
    texts: (m) => [m.settings.recognition.runningOn(GPU_NAME), m.gpu.heading, GPU_NAME, m.gpu.okSub, m.gpu.detect],
    absent: (m) => [m.settings.recognition.loadedSub.macos],
  },
  {
    name: "settings-recognition-integrated",
    query: "window=settings&mock=default&category=recognition&gpu=integrated",
    viewport: SETTINGS,
    texts: (m) => [m.gpu.integratedSub],
  },
  {
    name: "settings-recognition-gpu-none",
    query: "window=settings&mock=gpu-unavailable&category=recognition&gpu=none",
    viewport: SETTINGS,
    texts: (m) => [m.settings.recognition.gpuUnavailable, m.gpu.noneTitle, m.gpu.cpuWarning, m.gpu.continueCpuEllipsis],
  },
  {
    name: "settings-recognition-gpu-driver",
    query: "window=settings&mock=gpu-unavailable&category=recognition&gpu=driver_missing",
    viewport: SETTINGS,
    texts: (m) => [m.gpu.driverTitle, m.gpu.driverHint],
  },
  {
    name: "settings-recognition-cpu",
    query: "window=settings&mock=default&category=recognition&gpu=none&cpu=1",
    viewport: SETTINGS,
    texts: (m) => [m.settings.recognition.runningOnCpu, m.gpu.cpu, m.gpu.cpuSub],
    absent: (m) => [m.gpu.continueCpuEllipsis],
  },
  {
    name: "settings-permissions",
    query: "window=settings&mock=mic-not-determined&category=permissions",
    viewport: SETTINGS,
    texts: (m) => [m.settings.permissions.microphone, m.settings.permissions.micNotDetermined],
    absent: (m) => [m.settings.permissions.accessibility],
  },
  {
    name: "settings-storage",
    query: "window=settings&mock=default&category=storage",
    viewport: SETTINGS,
    texts: (m, os) => [os(m.settings.storage.runtime), m.settings.storage.uninstall, os(m.settings.storage.uninstallSub)],
  },
  {
    name: "settings-about",
    query: "window=settings&mock=default&category=about",
    viewport: SETTINGS,
    texts: (m, os) => [m.settings.about.logs, os(m.settings.about.showInFolder)],
    absent: (m) => [m.settings.about.showInFolder.macos],
  },
];

for (const c of cases) {
  test(c.name, { tag: [WINDOWS, SCREENSHOT] }, async ({ page, m, os, ui, appLocale, snap }) => {
    await open(page, c.query, c.viewport);
    for (const t of c.texts(m, os, ui, appLocale)) {
      await expect(page.getByText(t, { exact: false }).first()).toBeVisible();
    }
    for (const t of c.absent?.(m) ?? []) {
      await expect(page.getByText(t, { exact: false })).toHaveCount(0);
    }
    expect(await findOverflows(page)).toEqual([]);
    // モックの入力レベル (約15Hz) が届いてから撮る
    await snap(c.name, { settleMs: 250 });
  });
}

// ---------- OS の作法 ----------

test("OS は get_app_info の platform で決まり、信号機ボタンを描かない", { tag: WINDOWS }, async ({ page }) => {
  await open(page, "window=settings&mock=default", SETTINGS);
  await expect(page.locator("html")).toHaveAttribute("data-platform", "windows");
  // モック表示の信号機ボタン (グレーの丸 3 つ) を描かない
  await expect(page.locator("span.size-3.rounded-full")).toHaveCount(0);
});

test("shortcut: Ctrl・Alt・Shift・Win で表示・記録する", { tag: WINDOWS }, async ({ page, m, os }) => {
  await open(page, "window=setup&mock=input-mode", SETUP);
  const field = page.getByTestId("shortcut-field");
  await expect(field.locator("kbd")).toHaveText(["Alt", "Space"]);
  await page.getByRole("button", { name: m.shortcut.change }).click();
  await expect(page.getByText(os(m.shortcut.recordingGuide))).toBeVisible();
  await page.keyboard.down("Control");
  await expect(field.locator("kbd")).toHaveText(["Ctrl"]);
  await page.keyboard.up("Control");
  // Win キー (Meta) は Cmd として記録する
  await page.keyboard.press("Control+Shift+Meta+KeyM");
  await expect(field).toHaveAttribute("data-recording", "false");
  await expect(field.locator("kbd")).toHaveText(["Ctrl", "Shift", "Win", "M"]);
  await expect.poll(() => patches(page)).toContainEqual({ shortcut: "Ctrl+Shift+Cmd+KeyM" });
});

test("完了画面のオン／オフの案内はタスクトレイとショートカット", { tag: WINDOWS }, async ({ page, m }) => {
  await open(page, "window=setup&mock=done", SETUP);
  await expect(page.getByTestId("done-toggle-hint")).toHaveText(textOf(m.setup.done.hintWithKeys.windows("AltSpace")));
  // 登録できている時は案内を増やさない
  await expect(page.getByTestId("done-shortcut-conflict")).toHaveCount(0);
  await open(page, "window=setup&mock=done-oneshot", SETUP);
  await expect(page.getByTestId("done-toggle-hint")).toHaveText(textOf(m.setup.done.hintOneShot.windows("AltSpace")));
});

test("完了画面: ショートカットを登録できていなければ案内し、その場で変えられる (完了は止めない)", { tag: WINDOWS }, async ({ page, m, os }) => {
  await open(page, "window=setup&mock=done-conflict", SETUP);
  const notice = page.getByTestId("done-shortcut-conflict");
  await expect(notice.getByRole("status")).toHaveText(textOf(m.setup.done.shortcutConflict("AltSpace")));
  // 使えないキーを案内しない (オン／オフはパネル・トレイから)
  await expect(page.getByTestId("done-toggle-hint")).toHaveText(os(m.setup.done.hintNoKeys));
  await expect(page.getByRole("button", { name: m.common.close })).toBeEnabled();
  expect(await findOverflows(page)).toEqual([]);
  // 記録中 (登録を一時解除) も案内を消さない。別のキーで登録できたら消える
  await notice.getByRole("button", { name: m.shortcut.change }).click();
  await expect(notice.getByTestId("shortcut-field")).toHaveAttribute("data-recording", "true");
  await page.keyboard.press("Control+Shift+Space");
  await expect.poll(() => patches(page)).toContainEqual({ shortcut: "Ctrl+Shift+Space" });
  await expect(notice).toHaveCount(0);
  await expect(page.getByTestId("done-toggle-hint")).toHaveText(textOf(m.setup.done.hintWithKeys.windows("CtrlShiftSpace")));
});

test("自動送信の送信キーは Enter と Ctrl + Enter", { tag: WINDOWS }, async ({ page }) => {
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  const select = page.getByTestId("auto-submit-key");
  await expect(select.locator("option")).toHaveText(["Enter", "Ctrl + Enter"]);
});

test("音声コマンドの修飾キーは Ctrl・Alt・Shift・Win", { tag: WINDOWS }, async ({ page, m }) => {
  await open(page, "window=settings&mock=default&category=commands", SETTINGS);
  await page.getByRole("button", { name: m.settings.commands.add }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("group", { name: m.settings.commands.modifiers }).getByRole("button")).toHaveText([
    "Ctrl",
    "Alt",
    "Shift",
    "Win",
  ]);
});

test("入力しないアプリの候補に実行ファイル名を添える (名前と同じなら添えない)", { tag: WINDOWS }, async ({ page, m, appLocale }) => {
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  await page.getByRole("button", { name: m.settings.voice.addApp }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: MOCK_WINDOWS_TEXTS[appLocale].notepad })).toContainText("notepad.exe");
  await expect(menu.getByRole("menuitem", { name: "keepass.exe" }).getByTestId("app-id")).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Microsoft Edge" }).click();
  await expect.poll(() => patches(page)).toContainEqual({
    excludedApps: expect.arrayContaining([{ bundleId: "msedge.exe", name: "Microsoft Edge" }]),
  });
  expect(await findOverflows(page)).toEqual([]);
});

test("権限: マイクを拒否していれば Windows の設定 (マイク) を開く", { tag: WINDOWS }, async ({ page, m, os }) => {
  await open(page, "window=setup&mock=permissions-denied", SETUP);
  await page.getByRole("button", { name: os(m.common.openSystemSettings) }).click();
  await expect.poll(() => calls(page, "open_system_settings").then((c) => c.map((x) => x.args))).toEqual([{ pane: "microphone" }]);
  // アクセシビリティがないため、マイクを許可すれば次へ進める
  await expect(page.getByRole("button", { name: m.common.next })).toBeEnabled({ timeout: 5000 });
});

// ---------- GPU の判定と CPU 実行の同意 ----------

test("setup: GPU を使えれば画面を増やさずダウンロードを始める。判定はようこその間に取る", { tag: WINDOWS }, async ({ page, m }) => {
  await open(page, "window=setup&mock=default", SETUP);
  await expect(page.getByText(m.setup.welcome.title)).toBeVisible();
  await expect.poll(async () => (await calls(page, "get_gpu_status")).length).toBeGreaterThan(0);
  await page.getByRole("button", { name: m.setup.welcome.start }).click();
  await page.getByRole("button", { name: m.common.allow }).click();
  await page.getByRole("button", { name: m.common.next }).click();
  await expect(page.getByText(m.setup.download.titleRunning)).toBeVisible();
  await expect.poll(async () => (await calls(page, "start_provisioning")).length).toBe(1);
  await expect(page.getByText(m.gpu.noneTitle)).toHaveCount(0);
});

test("setup: 内蔵 GPU だけでも確認の画面を出さない", { tag: WINDOWS }, async ({ page, m }) => {
  await open(page, "window=setup&mock=default&step=3&gpu=integrated", SETUP);
  await expect(page.getByText(m.setup.download.titleRunning)).toBeVisible();
  await expect(page.getByText(m.gpu.cpuWarning)).toHaveCount(0);
});

test("setup: GPU がなければ同意するまでダウンロードを始めず、同意すると始める", { tag: WINDOWS }, async ({ page, m }) => {
  await open(page, "window=setup&mock=default&step=3&gpu=none", SETUP);
  const title = page.getByRole("heading", { name: m.gpu.noneTitle });
  await expect(title).toBeVisible();
  // 戻って入り直しても始めない
  await page.getByRole("button", { name: m.common.back }).click();
  await page.getByRole("button", { name: m.common.allow }).click();
  await page.getByRole("button", { name: m.common.next }).click();
  await expect(title).toBeVisible();
  expect(await calls(page, "start_provisioning")).toEqual([]);

  await page.getByRole("button", { name: m.gpu.continueCpu }).click();
  await expect.poll(() => patches(page)).toEqual([{ cpuInferenceAccepted: true }]);
  await expect(page.getByText(m.setup.download.titleRunning)).toBeVisible();
  await expect.poll(async () => (await calls(page, "start_provisioning")).length).toBe(1);
});

test("setup: 再検出で GPU が見つかれば同意せずにダウンロードを始める", { tag: WINDOWS }, async ({ page, m }) => {
  await open(page, "window=setup&mock=default&step=3&gpu=driver_missing&gpu-probe=ok", SETUP);
  await expect(page.getByRole("heading", { name: m.gpu.driverTitle })).toBeVisible();
  await page.getByRole("button", { name: m.gpu.detect }).click();
  await expect(page.getByText(m.setup.download.titleRunning)).toBeVisible();
  expect(await calls(page, "probe_gpu")).toHaveLength(1);
  expect(await patches(page)).toEqual([]);
  await expect.poll(async () => (await calls(page, "start_provisioning")).length).toBe(1);
});

test("settings: GPU を使えない時は確認のダイアログで同意する (やめるでは同意しない)", { tag: [WINDOWS, SCREENSHOT] }, async ({ page, m, snap }) => {
  await open(page, "window=settings&mock=gpu-unavailable&category=recognition&gpu=none", SETTINGS);
  const consent = page.getByTestId("gpu-consent");
  await consent.getByRole("button", { name: m.gpu.continueCpuEllipsis }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(m.gpu.consentTitle)).toBeVisible();
  await expect(dialog.getByText(m.gpu.cpuWarning)).toBeVisible();
  expect(await findOverflows(page)).toEqual([]);
  await snap("settings-recognition-gpu-consent-dialog");
  await dialog.getByRole("button", { name: m.gpu.cancel }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(await patches(page)).toEqual([]);

  await consent.getByRole("button", { name: m.gpu.continueCpuEllipsis }).click();
  await page.getByRole("dialog").getByRole("button", { name: m.gpu.continueCpu, exact: true }).click();
  await expect.poll(() => patches(page)).toEqual([{ cpuInferenceAccepted: true }]);
  await expect(page.getByTestId("gpu-section").getByText(m.gpu.cpuSub)).toBeVisible();
  await expect(page.getByTestId("gpu-consent")).toHaveCount(0);
  // 文字起こしを始める (gpu_unavailable が消える)
  await expect(page.getByText(m.settings.recognition.runningOnCpu)).toBeVisible();
});

test("settings: 再検出", { tag: WINDOWS }, async ({ page, m }) => {
  await open(page, "window=settings&mock=gpu-unavailable&category=recognition&gpu=none&gpu-probe=ok", SETTINGS);
  await page.getByTestId("gpu-section").getByRole("button", { name: m.gpu.detect }).click();
  await expect(page.getByTestId("gpu-section").getByText(GPU_NAME)).toBeVisible();
  await expect(page.getByTestId("gpu-consent")).toHaveCount(0);
  await expect(page.getByText(m.settings.recognition.runningOn(GPU_NAME))).toBeVisible();
});

test("panel: gpu_unavailable の「CPU で続ける」は設定の認識を開き、「再検出」は判定し直す", { tag: WINDOWS }, async ({ page, m }) => {
  await open(page, "window=panel&mock=error-gpu&gpu=none", PANEL);
  await page.getByRole("button", { name: m.errorActions.accept_cpu }).click();
  await expect.poll(() => calls(page, "open_settings").then((c) => c.map((x) => x.args))).toEqual([{ category: "recognition" }]);
  // パネルでは同意しない (注意書きを読んでから設定で同意する)
  expect(await patches(page)).toEqual([]);

  await open(page, "window=panel&mock=error-gpu-probe&gpu=driver_missing&gpu-probe=ok", PANEL);
  await page.getByRole("button", { name: m.errorActions.probe_gpu }).click();
  await expect.poll(async () => (await calls(page, "probe_gpu")).length).toBe(1);
  // GPU が見つかればエラーが消える
  await expect(page.getByRole("button", { name: m.panel.turnOn })).toBeVisible();
});

test("settings: アンインストールの確認ダイアログ", { tag: [WINDOWS, SCREENSHOT] }, async ({ page, m, os, snap }) => {
  await open(page, "window=settings&mock=default&category=storage", SETTINGS);
  await page.getByRole("button", { name: m.settings.storage.uninstallEllipsis }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("C:\\Users\\you\\AppData\\Local\\com.minimalcorp.mukuchi")).toBeVisible();
  await expect(dialog.getByText(os(m.settings.storage.uninstallCount)(2))).toBeVisible();
  expect(await findOverflows(page)).toEqual([]);
  await snap("settings-uninstall-dialog");
});
