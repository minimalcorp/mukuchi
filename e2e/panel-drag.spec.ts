/*
 * パネルのドラッグ移動 (押下後 4px 以上動いたら startDragging、動かさずに離したらクリック) と、
 * setup の動作テストで show_panel を呼ぶことの確認。
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

const PANEL = { width: 560, height: 260 };
const SETUP = { width: 640, height: 520 };

type Call = { cmd: string; args: Record<string, unknown> };
type Size = { width: number; height: number };
type Mock = { calls: Call[]; windowCalls: Call[] };

async function open(page: Page, query: string, viewport: Size) {
  await page.setViewportSize(viewport);
  await page.goto(`/?${query}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => "__mukuchiMock" in window);
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

const STATES = [
  { name: "OFF", query: "window=panel&mock=off", button: "音声入力をオン", on: true },
  { name: "ON", query: "window=panel&mock=idle", button: "音声入力をオフ", on: false },
];

for (const s of STATES) {
  test(`panel ${s.name}: ボタン上から 4px 以上動かすとドラッグになり、切り替えない`, async ({ page }) => {
    await open(page, s.query, PANEL);
    const button = page.getByRole("button", { name: s.button });
    await pressMove(page, button, 12);
    await expect.poll(() => dragCalls(page)).toBe(1);
    expect(await calls(page, "set_listening")).toHaveLength(0);
    await expect(button).toBeVisible();
  });

  test(`panel ${s.name}: 動かさずに離すとクリック (切り替え) になり、ドラッグしない`, async ({ page }) => {
    await open(page, s.query, PANEL);
    // 閾値未満の手ぶれもクリックとして扱う
    await pressMove(page, page.getByRole("button", { name: s.button }), 2);
    await expect.poll(async () => (await calls(page, "set_listening")).map((c) => c.args)).toEqual([{ on: s.on }]);
    expect(await dragCalls(page)).toBe(0);
  });

  test(`panel ${s.name}: ドラッグの後もキーボードで切り替えられる`, async ({ page }) => {
    await open(page, s.query, PANEL);
    const button = page.getByRole("button", { name: s.button });
    await pressMove(page, button, 12);
    await expect.poll(() => dragCalls(page)).toBe(1);
    await button.focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await calls(page, "set_listening")).map((c) => c.args)).toEqual([{ on: s.on }]);
  });
}

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

test("setup: 動作テストのステップに入ると show_panel を呼ぶ", async ({ page }) => {
  await open(page, "window=setup&mock=download-done", SETUP);
  await expect(page.getByText("試しに話してみてください")).toHaveCount(0);
  expect(await calls(page, "show_panel")).toHaveLength(0);
  await page.getByRole("button", { name: "次へ" }).click();
  await expect(page.getByText("試しに話してみてください")).toBeVisible();
  await expect.poll(async () => (await calls(page, "show_panel")).length).toBeGreaterThan(0);
});
