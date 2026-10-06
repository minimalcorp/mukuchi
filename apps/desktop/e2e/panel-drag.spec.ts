/*
 * パネルのドラッグ移動 (押下後 4px 以上動いたら startDragging、動かさずに離したらクリック) と、
 * 右クリックで show_panel_menu を呼ぶこと (ドラッグ・切り替えにならない)、
 * setup の動作テストで show_panel を呼ぶことの確認。
 */
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PANEL = { width: 560, height: 260 };
const SETUP = { width: 640, height: 520 };

type Call = { cmd: string; args: Record<string, unknown> };
type Size = { width: number; height: number };
type Mock = { calls: Call[]; windowCalls: Call[] };

async function open(page: Page, query: string, viewport: Size) {
  await page.setViewportSize(viewport);
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => "__mukuchiMock" in window);
  // 描画されてから待つ (描画前は同梱フォントの読み込みが始まっておらず、fonts.ready がすぐ解決する)
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0);
  await page.evaluate(() => document.fonts.ready);
}

function calls(page: Page, cmd: string): Promise<Call[]> {
  return page.evaluate(
    (c) => (window as unknown as { __mukuchiMock: Mock }).__mukuchiMock.calls.filter((x) => x.cmd === c),
    cmd,
  );
}

function dragCalls(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __mukuchiMock: Mock }).__mukuchiMock.windowCalls.filter(
        (x) => x.cmd === "plugin:window|start_dragging",
      ).length,
  );
}

/** 要素の中央で押し、dx だけ動かして離す */
async function pressMove(page: Page, target: Locator, dx: number) {
  const box = await target.boundingBox();
  if (!box) throw new Error("要素がありません");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  if (dx !== 0) await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

/** 修飾キーを押したまま pressMove する */
async function pressMoveWith(page: Page, target: Locator, dx: number, key: string) {
  await page.keyboard.down(key);
  try {
    await pressMove(page, target, dx);
  } finally {
    await page.keyboard.up(key);
  }
}

const STATES = [
  { name: "OFF", query: "window=panel&mock=off", button: "turnOn" as const, on: true },
  { name: "ON", query: "window=panel&mock=idle", button: "turnOff" as const, on: false },
];

/** 要素の中央 (ページ座標) */
async function center(target: Locator) {
  const box = await target.boundingBox();
  if (!box) throw new Error("要素がありません");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

for (const s of STATES) {
  test(`panel ${s.name}: ボタン上から 4px 以上動かすとドラッグになり切り替えず、その後もキーボードで切り替えられる`, async ({ page, m }) => {
    await open(page, s.query, PANEL);
    const button = page.getByRole("button", { name: m.panel[s.button] });
    await pressMove(page, button, 12);
    await expect.poll(() => dragCalls(page)).toBe(1);
    expect(await calls(page, "set_listening")).toHaveLength(0);
    await expect(button).toBeVisible();
    await button.focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await calls(page, "set_listening")).map((c) => c.args)).toEqual([{ on: s.on }]);
  });

  test(`panel ${s.name}: 動かさずに離すとクリック (切り替え) になり、ドラッグしない`, async ({ page, m }) => {
    await open(page, s.query, PANEL);
    // 閾値未満の手ぶれもクリックとして扱う
    await pressMove(page, page.getByRole("button", { name: m.panel[s.button] }), 2);
    await expect.poll(async () => (await calls(page, "set_listening")).map((c) => c.args)).toEqual([{ on: s.on }]);
    expect(await dragCalls(page)).toBe(0);
  });

  test(`panel ${s.name}: ボタン上の右クリックで show_panel_menu を呼び、右クリック・control + クリックは切り替え・ドラッグしない`, async ({ page, m }) => {
    await open(page, s.query, PANEL);
    const button = page.getByRole("button", { name: m.panel[s.button] });
    const { x, y } = await center(button);
    // 押したまま動かしてもドラッグにしない
    await page.mouse.move(x, y);
    await page.mouse.down({ button: "right" });
    await page.mouse.move(x + 12, y, { steps: 4 });
    await page.mouse.up({ button: "right" });
    await expect.poll(async () => (await calls(page, "show_panel_menu")).length).toBe(1);
    const [menu] = await calls(page, "show_panel_menu");
    // ビューポート = panel ウィンドウなので clientX/Y はページ座標と一致する
    // 押した位置が端数 (ボタンの幅が奇数) の時、clientX/Y の丸めは WebKit 次第のため 1px までの差は許す
    const args = menu.args as { x: number; y: number };
    expect(Math.abs(args.x - x)).toBeLessThanOrEqual(1);
    expect(Math.abs(args.y - y)).toBeLessThanOrEqual(1);
    // control + クリック (macOS の副クリック) も切り替え・ドラッグしない
    await button.click({ modifiers: ["Control"] });
    await pressMoveWith(page, button, 12, "Control");
    expect(await calls(page, "set_listening")).toHaveLength(0);
    expect(await dragCalls(page)).toBe(0);
  });
}

test("panel ON: メーター上の右クリックでも show_panel_menu を呼ぶ", async ({ page }) => {
  await open(page, "window=panel&mock=idle", PANEL);
  await page.getByTestId("level-meter").click({ button: "right" });
  await expect.poll(async () => (await calls(page, "show_panel_menu")).length).toBe(1);
  expect(await calls(page, "set_listening")).toHaveLength(0);
  expect(await dragCalls(page)).toBe(0);
});

test("panel: WebView 標準の右クリックメニューはどこでも出さない", async ({ page }) => {
  await open(page, "window=panel&mock=off", PANEL);
  await expect(page.getByTestId("panel-pill")).toBeVisible();
  const prevented = await page.evaluate(() => {
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 1, clientY: 1 });
    document.body.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(prevented).toBe(true);
  // ピル・カードの外ではメニューを出さない
  expect(await calls(page, "show_panel_menu")).toHaveLength(0);
});

test("panel ON: ボタン以外の場所 (メーター) からもドラッグできる", async ({ page }) => {
  await open(page, "window=panel&mock=idle", PANEL);
  await pressMove(page, page.getByTestId("level-meter"), 12);
  await expect.poll(() => dragCalls(page)).toBe(1);
  expect(await calls(page, "set_listening")).toHaveLength(0);
});

test("panel: 余白ではドラッグしない", async ({ page }) => {
  await open(page, "window=panel&mock=off", PANEL);
  await expect(page.getByTestId("panel-frame")).toHaveCSS("pointer-events", "none");
});

test("setup: 動作テストのステップに入ると show_panel を呼ぶ", async ({ page, m }) => {
  await open(page, "window=setup&mock=download-done", SETUP);
  await expect(page.getByText(m.setup.test.title)).toHaveCount(0);
  expect(await calls(page, "show_panel")).toHaveLength(0);
  await page.getByRole("button", { name: m.common.next }).click();
  // 入力モードのステップでは出さない
  await expect(page.getByText(m.setup.inputMode.title)).toBeVisible();
  expect(await calls(page, "show_panel")).toHaveLength(0);
  await page.getByRole("button", { name: m.common.next }).click();
  await expect(page.getByText(m.setup.test.title)).toBeVisible();
  await expect.poll(async () => (await calls(page, "show_panel")).length).toBeGreaterThan(0);
});
