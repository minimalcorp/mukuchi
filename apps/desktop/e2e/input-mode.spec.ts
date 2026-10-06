/*
 * 入力モードとグローバルショートカットの確認: セットアップの入力モードのステップ・動作テストの案内の切り替え、
 * ショートカットの記録 (一時解除・修飾キー必須・取り消し・なし・登録できない時のエラー)、設定 > 音声入力。
 */
import { isValidElement, type ReactNode } from "react";
import { expect, I18N, SCREENSHOT, test } from "./fixtures";
import type { Page } from "@playwright/test";
import { SAMPLE_PHRASES } from "../src/i18n/speech";

/** 辞書の rich な文言の表示テキスト (差し込んだキーは "⌥Space" のように文字列で渡す) */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

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

/** ショートカットに関わる command だけを順に (一時解除と保存の順序を確かめる) */
function shortcutCalls(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { __mukuchiMock: { calls: Call[] } }).__mukuchiMock.calls
      .filter((x) => x.cmd === "set_shortcut_suspended" || (x.cmd === "update_settings" && "shortcut" in (x.args.patch as object)))
      .map((x) => (x.cmd === "update_settings" ? `update:${String((x.args.patch as { shortcut: unknown }).shortcut)}` : `suspended:${String(x.args.suspended)}`)),
  );
}

function savedSetting<K extends string>(page: Page, key: K): Promise<unknown> {
  return page.evaluate(
    (k) => (window as unknown as { __mukuchiMock: { db: { settings: Record<string, unknown> } } }).__mukuchiMock.db.settings[k],
    key,
  );
}

// ---------- セットアップ: 入力モード ----------

test("setup: ダウンロードの次は入力モード。選ぶとすぐ保存し、こんなときに・説明が切り替わる", async ({ page, m }) => {
  await open(page, "window=setup&mock=download-done", SETUP);
  await page.getByRole("button", { name: m.common.next }).click();
  await expect(page.getByText(m.setup.inputMode.title)).toBeVisible();
  await expect(page.getByLabel(m.setup.progress(4, 6))).toBeVisible();
  const continuous = page.getByRole("radio", { name: m.inputMode.continuous.label });
  const oneShot = page.getByRole("radio", { name: m.inputMode.oneShot.label });
  await expect(continuous).toBeChecked();
  await expect(page.getByTestId("input-mode-use-cases")).toContainText(m.inputMode.continuous.useCases[0]);

  await page.getByText(m.inputMode.oneShot.label, { exact: true }).click();
  await expect(oneShot).toBeChecked();
  await expect.poll(() => savedSetting(page, "inputMode")).toBe("oneShot");
  expect((await calls(page, "update_settings")).map((c) => c.args.patch)).toEqual([{ inputMode: "oneShot" }]);
  await expect(page.getByTestId("input-mode-use-cases")).toContainText(m.inputMode.oneShot.useCases[0]);
  await expect(page.getByText(m.inputMode.shortcutHint.oneShot)).toBeVisible();
});

test("setup: 入力モードの保存に失敗したら元に戻してエラーを出す", async ({ page, m }) => {
  await open(page, "window=setup&mock=input-mode", SETUP);
  await page.evaluate(() => {
    (window as unknown as { __mukuchiMock: { fail: Record<string, string> } }).__mukuchiMock.fail.update_settings =
      "設定を保存できませんでした";
  });
  await page.getByText(m.inputMode.oneShot.label, { exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("設定を保存できませんでした");
  await expect(page.getByRole("radio", { name: m.inputMode.continuous.label })).toBeChecked();
});

// 案内の文言は話す言語の例文とキーを差し込む (語順が表示言語で違う)
test("setup: 動作テストの案内は入力モードで変わる", { tag: I18N }, async ({ page, m, appLocale }) => {
  await open(page, "window=setup&mock=input-mode", SETUP);
  await page.getByRole("button", { name: m.common.next }).click();
  const instruction = page.getByTestId("test-instruction");
  const sample = SAMPLE_PHRASES[appLocale];
  await expect(instruction).toHaveText(textOf(m.setup.test.continuousWithKeys("⌥Space", sample)));

  await page.getByRole("button", { name: m.common.back }).click();
  await page.getByText(m.inputMode.oneShot.label, { exact: true }).click();
  await expect.poll(() => savedSetting(page, "inputMode")).toBe("oneShot");
  await page.getByRole("button", { name: m.common.next }).click();
  await expect(instruction).toHaveText(textOf(m.setup.test.oneShotWithKeys("⌥Space", sample)));

  // ショートカットなしでは押すキーを案内できないため、パネルでオンにしてもらう
  await page.getByRole("button", { name: m.common.back }).click();
  await page.getByRole("button", { name: m.shortcut.clear }).click();
  await expect(page.getByTestId("shortcut-field")).toHaveText(m.shortcut.none);
  await page.getByRole("button", { name: m.common.next }).click();
  await expect(instruction).toHaveText(m.setup.test.oneShotNoKeys(sample));
});

test("setup: 完了画面のオン／オフの案内にショートカットを出す", { tag: I18N }, async ({ page, m }) => {
  await open(page, "window=setup&mock=done", SETUP);
  await expect(page.getByTestId("done-toggle-hint")).toHaveText(textOf(m.setup.done.hintWithKeys("⌥Space")));
  await open(page, "window=setup&mock=done-oneshot", SETUP);
  await expect(page.getByTestId("done-toggle-hint")).toHaveText(textOf(m.setup.done.hintOneShot("⌥Space")));
});

// ---------- ショートカットの記録 ----------

test("shortcut: 記録中は登録を一時解除し、戻してから保存する", async ({ page, m }) => {
  await open(page, "window=setup&mock=input-mode", SETUP);
  const field = page.getByTestId("shortcut-field");
  await expect(field).toHaveText("⌥Space");
  await page.getByRole("button", { name: m.shortcut.change }).click();
  await expect(field).toHaveAttribute("data-recording", "true");
  await expect(field).toBeFocused();
  await expect.poll(() => shortcutCalls(page)).toEqual(["suspended:true"]);

  // 修飾キーだけでは確定しない。修飾キーなしのキーは受け付けず案内を出す
  await page.keyboard.down("Shift");
  await expect(field).toContainText("⇧");
  await page.keyboard.up("Shift");
  await page.keyboard.press("KeyK");
  await expect(field).toHaveAttribute("data-recording", "true");
  await expect(page.getByText(m.shortcut.recordingGuide)).toBeVisible();

  // Rust が受け付けないキー (JIS の ¥) は保存せず案内を出す
  // Playwright の US 配列に IntlYen がないため、keydown を直接送る
  await field.dispatchEvent("keydown", { code: "IntlYen", key: "¥", altKey: true, bubbles: true });
  await expect(field).toHaveAttribute("data-recording", "true");
  await expect(page.getByText(m.shortcut.unsupportedGuide)).toBeVisible();

  await page.keyboard.press("Shift+Meta+KeyK");
  await expect(field).toHaveAttribute("data-recording", "false");
  await expect(field).toHaveText("⇧⌘K");
  await expect.poll(() => shortcutCalls(page)).toEqual(["suspended:true", "suspended:false", "update:Shift+Cmd+KeyK"]);
  await expect.poll(() => savedSetting(page, "shortcut")).toBe("Shift+Cmd+KeyK");
  await expect(page.getByRole("button", { name: m.shortcut.change })).toBeVisible();
});

test("shortcut: 登録できないキーはエラーを出し、元のショートカットのまま", { tag: SCREENSHOT }, async ({ page, m, ui, snap }) => {
  await open(page, "window=setup&mock=input-mode", SETUP);
  const field = page.getByTestId("shortcut-field");
  await page.getByRole("button", { name: m.shortcut.change }).click();
  // モックは ⌘Space を登録できない (OS が拒否する) 想定
  await page.keyboard.press("Meta+Space");
  await expect(page.getByRole("alert")).toHaveText(ui.reject.shortcut("⌘ Space"));
  await expect(field).toHaveText("⌥Space");
  expect(await savedSetting(page, "shortcut")).toBe("Alt+Space");
  await snap("setup-4-input-mode-shortcut-error");

  // 登録できるキーにし直したらエラーを消す
  await page.getByRole("button", { name: m.shortcut.change }).click();
  await page.keyboard.press("Control+Alt+KeyM");
  await expect(field).toHaveText("⌃⌥M");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("shortcut: esc で取り消し (保存しない)、⌫ でなしにする", async ({ page, m }) => {
  await open(page, "window=setup&mock=input-mode", SETUP);
  const field = page.getByTestId("shortcut-field");
  await page.getByRole("button", { name: m.shortcut.change }).click();
  await page.keyboard.press("Escape");
  await expect(field).toHaveAttribute("data-recording", "false");
  await expect(field).toHaveText("⌥Space");
  await expect.poll(() => shortcutCalls(page)).toEqual(["suspended:true", "suspended:false"]);

  await page.getByRole("button", { name: m.shortcut.change }).click();
  await page.keyboard.press("Backspace");
  await expect(field).toHaveText(m.shortcut.none);
  await expect.poll(() => savedSetting(page, "shortcut")).toBe(null);
  await expect(page.getByRole("button", { name: m.shortcut.clear })).toHaveCount(0);
});

test("shortcut: キャンセル・フォーカスが外れた・ステップを離れた時は一時解除を戻す", async ({ page, m }) => {
  await open(page, "window=setup&mock=input-mode", SETUP);
  const field = page.getByTestId("shortcut-field");
  await page.getByRole("button", { name: m.shortcut.change }).click();
  await page.getByRole("button", { name: m.common.cancel }).click();
  await expect(field).toHaveAttribute("data-recording", "false");
  await expect.poll(() => shortcutCalls(page)).toEqual(["suspended:true", "suspended:false"]);

  // 他の操作でフォーカスが外れたら取り消す
  await page.getByRole("button", { name: m.shortcut.change }).click();
  await page.getByRole("radio", { name: m.inputMode.oneShot.label }).click();
  await expect(field).toHaveAttribute("data-recording", "false");
  await expect.poll(() => shortcutCalls(page)).toEqual(["suspended:true", "suspended:false", "suspended:true", "suspended:false"]);

  // 記録中に次へ進んでも (ボタンを押す前にフォーカスが外れて) 戻す
  await page.getByRole("button", { name: m.shortcut.change }).click();
  await page.getByRole("button", { name: m.common.next }).click();
  await expect(page.getByText(m.setup.test.title)).toBeVisible();
  await expect.poll(async () => (await shortcutCalls(page)).at(-1)).toBe("suspended:false");
  expect(await savedSetting(page, "shortcut")).toBe("Alt+Space");
});

test("shortcut: 起動時に登録できなかった時は警告を出す", async ({ page, m, ui }) => {
  await open(page, "window=setup&mock=input-mode-conflict", SETUP);
  await expect(page.getByRole("status").filter({ hasText: ui.shortcutConflict("⌥ Space") })).toBeVisible();
  // 登録できるキーに変えたら消える
  await page.getByRole("button", { name: m.shortcut.change }).click();
  await page.keyboard.press("Control+Alt+KeyM");
  await expect(page.getByText(ui.shortcutConflict("⌥ Space"))).toHaveCount(0);
});

// ---------- 設定 > 音声入力 ----------

test("settings: 音声入力で入力モードとショートカットを変えられる", async ({ page, m, ui }) => {
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  await expect(page.getByRole("radio", { name: m.inputMode.continuous.label })).toBeChecked();
  await page.getByText(m.inputMode.oneShot.label, { exact: true }).click();
  await expect(page.getByRole("radio", { name: m.inputMode.oneShot.label })).toBeChecked();
  await expect.poll(() => savedSetting(page, "inputMode")).toBe("oneShot");
  await expect(page.getByText(m.inputMode.shortcutHint.oneShot)).toBeVisible();

  const field = page.getByTestId("shortcut-field");
  await page.getByRole("button", { name: m.shortcut.change }).click();
  await page.keyboard.press("Control+Space");
  await expect(page.getByRole("alert")).toHaveText(ui.reject.shortcut("⌃ Space"));
  await page.getByRole("button", { name: m.shortcut.change }).click();
  await page.keyboard.press("Alt+Digit1");
  await expect(field).toHaveText("⌥1");
  await expect.poll(() => savedSetting(page, "shortcut")).toBe("Alt+Digit1");
  await expect.poll(() => shortcutCalls(page)).toEqual([
    "suspended:true",
    "suspended:false",
    "update:Ctrl+Space",
    "suspended:true",
    "suspended:false",
    "update:Alt+Digit1",
  ]);
});
