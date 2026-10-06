/*
 * 音声入力の ON/OFF の切り替え (OFF のピル ⇄ 待機中のピル) のアニメーション。
 * 面 (panel-morph) が切り替え前の大きさから切り替え後の大きさへ変わり、その間 切り替え後の内容は見えないこと、
 * set_panel_size は広げる時は最初に最終の大きさ、縮む時は終わってから 1 回だけ送ることを確認する。
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PANEL = { width: 560, height: 260 };
// 影の余白 (PanelFrame の px-6 pt-4 pb-8) + 待機中のピル (240 x 36)
const PILL_SIZE = { width: 24 + 240 + 24, height: 16 + 36 + 32 };

type Size = { width: number; height: number };
type Call = { cmd: string; args: Record<string, unknown> };
/** 1 フレームの面と描画内容 (morph が出ていない時は null) */
type Frame = { morph: Size | null; bodyVisible: boolean };

async function open(page: Page, mock: string) {
  await page.setViewportSize(PANEL);
  await page.goto(`/?window=panel&mock=${mock}`);
  await page.waitForFunction(() => "__mukuchiMock" in window);
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0);
  await page.evaluate(() => document.fonts.ready);
}

function panelSizes(page: Page): Promise<Size[]> {
  return page.evaluate(() =>
    (window as unknown as { __mukuchiMock: { calls: Call[] } }).__mukuchiMock.calls
      .filter((c) => c.cmd === "set_panel_size")
      .map((c) => c.args as Size),
  );
}

async function pillSize(page: Page): Promise<Size> {
  const box = (await page.getByTestId("panel-pill").boundingBox())!;
  return { width: box.width, height: box.height };
}

/** ボタンを押してから、面が出て消えるまで毎フレーム記録する */
function recordToggle(page: Page, name: string): Promise<Frame[]> {
  return page.evaluate(async (name) => {
    const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent === name || b.ariaLabel === name)!;
    button.click();
    const out: { morph: { width: number; height: number } | null; bodyVisible: boolean }[] = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 1500) {
      await new Promise((r) => requestAnimationFrame(r));
      const morph = q("panel-morph");
      const rect = morph.getBoundingClientRect();
      const body = morph.previousElementSibling as HTMLElement;
      out.push({
        morph: morph.hidden ? null : { width: rect.width, height: rect.height },
        bodyVisible: getComputedStyle(body).visibility === "visible",
      });
      if (out.some((f) => f.morph) && morph.hidden) break;
    }
    return out;
  }, name);
}

test("panel: OFF → ON は面がピルの大きさへ広がってから待機中を出し、最初に最終の大きさを送る", async ({ page, m }) => {
  await open(page, "off");
  await expect(page.getByText(m.panel.turnOn)).toBeVisible();
  const from = await pillSize(page);
  await expect.poll(async () => (await panelSizes(page)).length).toBeGreaterThan(0);
  const before = (await panelSizes(page)).length;

  const frames = await recordToggle(page, m.panel.turnOn);
  const morphing = frames.filter((f) => f.morph);
  expect(morphing.length).toBeGreaterThan(2);
  // 面が出ている間は切り替え後の内容を見せない
  expect(morphing.every((f) => !f.bodyVisible)).toBe(true);
  expect(morphing[0].morph!.width).toBeLessThan(240);
  expect(morphing[0].morph!.width).toBeGreaterThanOrEqual(from.width - 1);
  // 最後に記録したフレームは終わりの直前のことがある
  expect(Math.abs(morphing.at(-1)!.morph!.width - 240)).toBeLessThan(8);
  expect(frames.at(-1)!.morph).toBeNull();
  expect(frames.at(-1)!.bodyVisible).toBe(true);

  await expect(page.getByText(m.panel.idle)).toBeVisible();
  // 広げる時は最初の 1 回で最終の大きさ (ピルが途中で切れない)
  await expect.poll(async () => (await panelSizes(page)).slice(before)).toEqual([PILL_SIZE]);
});

test("panel: ON → OFF は面が OFF のピルの大きさへ縮んでから出し、終わってから 1 回だけ送る", async ({ page, m }) => {
  await open(page, "idle");
  await expect(page.getByText(m.panel.idle)).toBeVisible();
  await expect.poll(async () => (await panelSizes(page)).at(-1)).toEqual(PILL_SIZE);
  const before = (await panelSizes(page)).length;

  const frames = await recordToggle(page, m.panel.turnOff);
  const morphing = frames.filter((f) => f.morph);
  expect(morphing.length).toBeGreaterThan(2);
  expect(morphing.every((f) => !f.bodyVisible)).toBe(true);
  expect(morphing[0].morph!.width).toBeGreaterThan(morphing.at(-1)!.morph!.width);
  expect(morphing[0].morph!.width).toBeLessThanOrEqual(240);
  expect(frames.at(-1)!.morph).toBeNull();

  await expect(page.getByText(m.panel.turnOn)).toBeVisible();
  const to = await pillSize(page);
  expect(Math.abs(morphing.at(-1)!.morph!.width - to.width)).toBeLessThan(8);
  // 縮み終わってから最終の大きさを 1 回だけ送る (途中の大きさでウィンドウを縮めない)
  await expect
    .poll(async () => (await panelSizes(page)).slice(before))
    .toEqual([{ width: Math.ceil((24 + to.width + 24) / 2) * 2, height: Math.ceil(16 + to.height + 32) }]);
});

test("panel: 状態が同じ種類の中で変わる時 (待機中 → 認識中) は面を出さない", async ({ page, m }) => {
  await open(page, "idle");
  await expect(page.getByText(m.panel.idle)).toBeVisible();
  const seen = await page.evaluate(async () => {
    const api = (window as unknown as { __mukuchiMock: { setStatus: (p: object) => void } }).__mukuchiMock;
    api.setStatus({ phase: "speaking" });
    const morph = document.querySelector<HTMLElement>('[data-testid="panel-morph"]')!;
    let shown = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      shown ||= !morph.hidden;
    }
    return shown;
  });
  expect(seen).toBe(false);
});

test("panel: 動きを減らす設定では面を出さずに切り替える", async ({ page, m }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, "off");
  await expect(page.getByText(m.panel.turnOn)).toBeVisible();
  const frames = await page.evaluate(async (turnOn) => {
    const morph = document.querySelector<HTMLElement>('[data-testid="panel-morph"]')!;
    [...document.querySelectorAll("button")].find((b) => b.textContent === turnOn)!.click();
    const out: boolean[] = [];
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      out.push(morph.hidden === true);
    }
    return out;
  }, m.panel.turnOn);
  expect(frames.every((hidden) => hidden)).toBe(true);
  await expect(page.getByText(m.panel.idle)).toBeVisible();
});
