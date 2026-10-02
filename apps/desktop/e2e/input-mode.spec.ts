/*
 * 入力モードとグローバルショートカットの確認: セットアップの入力モードのステップ・動作テストの案内の切り替え、
 * ショートカットの記録 (一時解除・修飾キー必須・取り消し・なし・登録できない時のエラー)、設定 > 音声入力。
 */
import { expect, test, type Page } from "@playwright/test";

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

test("setup: ダウンロードの次は入力モード。選ぶとすぐ保存し、こんなときに・説明が切り替わる", async ({ page }) => {
  await open(page, "window=setup&mock=download-done", SETUP);
  await page.getByRole("button", { name: "次へ" }).click();
  await expect(page.getByText("入力のしかたを選んでください")).toBeVisible();
  await expect(page.getByLabel("4 / 6")).toBeVisible();
  const continuous = page.getByRole("radio", { name: "常に聞き取る" });
  const oneShot = page.getByRole("radio", { name: "1回ずつ聞き取る" });
  await expect(continuous).toBeChecked();
  await expect(page.getByTestId("input-mode-use-cases")).toContainText("ひとりで作業しているとき");

  await page.getByText("1回ずつ聞き取る", { exact: true }).click();
  await expect(oneShot).toBeChecked();
  await expect.poll(() => savedSetting(page, "inputMode")).toBe("oneShot");
  expect((await calls(page, "update_settings")).map((c) => c.args.patch)).toEqual([{ inputMode: "oneShot" }]);
  await expect(page.getByTestId("input-mode-use-cases")).toContainText("周りに人がいる・会話が聞こえる場所");
  await expect(page.getByText("押すと1回聞き取ります。話し終わると自動でオフになります")).toBeVisible();
});

test("setup: 入力モードの保存に失敗したら元に戻してエラーを出す", async ({ page }) => {
  await open(page, "window=setup&mock=input-mode", SETUP);
  await page.evaluate(() => {
    (window as unknown as { __mukuchiMock: { fail: Record<string, string> } }).__mukuchiMock.fail.update_settings =
      "設定を保存できませんでした";
  });
  await page.getByText("1回ずつ聞き取る", { exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("設定を保存できませんでした");
  await expect(page.getByRole("radio", { name: "常に聞き取る" })).toBeChecked();
});

test("setup: 動作テストの案内は入力モードで変わる", async ({ page }) => {
  await open(page, "window=setup&mock=input-mode", SETUP);
  await page.getByRole("button", { name: "次へ" }).click();
  const instruction = page.getByTestId("test-instruction");
  await expect(instruction).toContainText("パネルか");
  await expect(instruction).toContainText("⌥Space で音声入力をオンにして");
  await expect(instruction).not.toContainText("自動でオフ");

  await page.getByRole("button", { name: "戻る" }).click();
  await page.getByText("1回ずつ聞き取る", { exact: true }).click();
  await expect.poll(() => savedSetting(page, "inputMode")).toBe("oneShot");
  await page.getByRole("button", { name: "次へ" }).click();
  await expect(instruction).toContainText("⌥Space を押して、「君は無口だね」のように話してください。話し終わると自動でオフになります。");

  // ショートカットなしでは押すキーを案内できないため、パネルでオンにしてもらう
  await page.getByRole("button", { name: "戻る" }).click();
  await page.getByRole("button", { name: "ショートカットをなしにする" }).click();
  await expect(page.getByTestId("shortcut-field")).toHaveText("なし");
  await page.getByRole("button", { name: "次へ" }).click();
  await expect(instruction).toContainText("パネルで音声入力をオンにして");
  await expect(instruction).toContainText("話し終わると自動でオフになります。");
});

test("setup: 完了画面のオン／オフの案内にショートカットを出す", async ({ page }) => {
  await open(page, "window=setup&mock=done", SETUP);
  await expect(page.getByTestId("done-toggle-hint")).toContainText("オン／オフはパネル・メニューバーのアイコン・⌥Spaceで切り替えます");
  await open(page, "window=setup&mock=done-oneshot", SETUP);
  await expect(page.getByTestId("done-toggle-hint")).toContainText("⌥Space を押すと1回聞き取ります");
});

// ---------- ショートカットの記録 ----------

test("shortcut: 記録中は登録を一時解除し、戻してから保存する", async ({ page }) => {
  await open(page, "window=setup&mock=input-mode", SETUP);
  const field = page.getByTestId("shortcut-field");
  await expect(field).toHaveText("⌥Space");
  await page.getByRole("button", { name: "変更" }).click();
  await expect(field).toHaveAttribute("data-recording", "true");
  await expect(field).toBeFocused();
  await expect.poll(() => shortcutCalls(page)).toEqual(["suspended:true"]);

  // 修飾キーだけでは確定しない。修飾キーなしのキーは受け付けず案内を出す
  await page.keyboard.down("Shift");
  await expect(field).toContainText("⇧");
  await page.keyboard.up("Shift");
  await page.keyboard.press("KeyK");
  await expect(field).toHaveAttribute("data-recording", "true");
  await expect(page.getByText("のいずれかと一緒に押してください")).toBeVisible();

  // Rust が受け付けないキー (JIS の ¥) は保存せず案内を出す
  // Playwright の US 配列に IntlYen がないため、keydown を直接送る
  await field.dispatchEvent("keydown", { code: "IntlYen", key: "¥", altKey: true, bubbles: true });
  await expect(field).toHaveAttribute("data-recording", "true");
  await expect(page.getByText("このキーはショートカットに使えません")).toBeVisible();

  await page.keyboard.press("Shift+Meta+KeyK");
  await expect(field).toHaveAttribute("data-recording", "false");
  await expect(field).toHaveText("⇧⌘K");
  await expect.poll(() => shortcutCalls(page)).toEqual(["suspended:true", "suspended:false", "update:Shift+Cmd+KeyK"]);
  await expect.poll(() => savedSetting(page, "shortcut")).toBe("Shift+Cmd+KeyK");
  await expect(page.getByRole("button", { name: "変更" })).toBeVisible();
});

test("shortcut: 登録できないキーはエラーを出し、元のショートカットのまま", async ({ page }) => {
  await open(page, "window=setup&mock=input-mode", SETUP);
  const field = page.getByTestId("shortcut-field");
  await page.getByRole("button", { name: "変更" }).click();
  // モックは ⌘Space を登録できない (OS が拒否する) 想定
  await page.keyboard.press("Meta+Space");
  await expect(page.getByRole("alert")).toHaveText("ショートカット「⌘ Space」を登録できませんでした。別のキーに変更してください");
  await expect(field).toHaveText("⌥Space");
  expect(await savedSetting(page, "shortcut")).toBe("Alt+Space");
  await page.screenshot({ path: "e2e/screenshots/setup-4-input-mode-shortcut-error.png" });

  // 登録できるキーにし直したらエラーを消す
  await page.getByRole("button", { name: "変更" }).click();
  await page.keyboard.press("Control+Alt+KeyM");
  await expect(field).toHaveText("⌃⌥M");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("shortcut: esc で取り消し (保存しない)、⌫ でなしにする", async ({ page }) => {
  await open(page, "window=setup&mock=input-mode", SETUP);
  const field = page.getByTestId("shortcut-field");
  await page.getByRole("button", { name: "変更" }).click();
  await page.keyboard.press("Escape");
  await expect(field).toHaveAttribute("data-recording", "false");
  await expect(field).toHaveText("⌥Space");
  await expect.poll(() => shortcutCalls(page)).toEqual(["suspended:true", "suspended:false"]);

  await page.getByRole("button", { name: "変更" }).click();
  await page.keyboard.press("Backspace");
  await expect(field).toHaveText("なし");
  await expect.poll(() => savedSetting(page, "shortcut")).toBe(null);
  await expect(page.getByRole("button", { name: "ショートカットをなしにする" })).toHaveCount(0);
});

test("shortcut: キャンセル・フォーカスが外れた・ステップを離れた時は一時解除を戻す", async ({ page }) => {
  await open(page, "window=setup&mock=input-mode", SETUP);
  const field = page.getByTestId("shortcut-field");
  await page.getByRole("button", { name: "変更" }).click();
  await page.getByRole("button", { name: "キャンセル" }).click();
  await expect(field).toHaveAttribute("data-recording", "false");
  await expect.poll(() => shortcutCalls(page)).toEqual(["suspended:true", "suspended:false"]);

  // 他の操作でフォーカスが外れたら取り消す
  await page.getByRole("button", { name: "変更" }).click();
  await page.getByRole("radio", { name: "1回ずつ聞き取る" }).click();
  await expect(field).toHaveAttribute("data-recording", "false");
  await expect.poll(() => shortcutCalls(page)).toEqual(["suspended:true", "suspended:false", "suspended:true", "suspended:false"]);

  // 記録中に次へ進んでも (ボタンを押す前にフォーカスが外れて) 戻す
  await page.getByRole("button", { name: "変更" }).click();
  await page.getByRole("button", { name: "次へ" }).click();
  await expect(page.getByText("試しに話してみてください")).toBeVisible();
  await expect.poll(async () => (await shortcutCalls(page)).at(-1)).toBe("suspended:false");
  expect(await savedSetting(page, "shortcut")).toBe("Alt+Space");
});

test("shortcut: 起動時に登録できなかった時は警告を出す", async ({ page }) => {
  await open(page, "window=setup&mock=input-mode-conflict", SETUP);
  await expect(page.getByRole("status").filter({ hasText: "ショートカット「⌥ Space」を登録できませんでした。別のキーに変更してください" })).toBeVisible();
  // 登録できるキーに変えたら消える
  await page.getByRole("button", { name: "変更" }).click();
  await page.keyboard.press("Control+Alt+KeyM");
  await expect(page.getByText("登録できませんでした")).toHaveCount(0);
});

// ---------- 設定 > 音声入力 ----------

test("settings: 音声入力で入力モードとショートカットを変えられる", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  await expect(page.getByRole("radio", { name: "常に聞き取る" })).toBeChecked();
  await page.getByText("1回ずつ聞き取る", { exact: true }).click();
  await expect(page.getByRole("radio", { name: "1回ずつ聞き取る" })).toBeChecked();
  await expect.poll(() => savedSetting(page, "inputMode")).toBe("oneShot");
  await expect(page.getByText("押すと1回聞き取ります。話し終わると自動でオフになります")).toBeVisible();

  const field = page.getByTestId("shortcut-field");
  await page.getByRole("button", { name: "変更" }).click();
  await page.keyboard.press("Control+Space");
  await expect(page.getByRole("alert")).toHaveText("ショートカット「⌃ Space」を登録できませんでした。別のキーに変更してください");
  await page.getByRole("button", { name: "変更" }).click();
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

test("settings: 他のウィンドウで変えた入力モードを反映する", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  await page.evaluate(() =>
    (window as unknown as { __mukuchiMock: { invoke: (c: string, a: unknown) => Promise<unknown> } }).__mukuchiMock.invoke(
      "update_settings",
      { patch: { inputMode: "oneShot" } },
    ),
  );
  await expect(page.getByRole("radio", { name: "1回ずつ聞き取る" })).toBeChecked();
});
