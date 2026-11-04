/*
 * 音声入力の ON/OFF の切り替え (OFF のピル ⇄ 待機中のピル)。
 * set_panel_size は広げる時は最初に最終の大きさ、縮む時は終わってから最終の大きさを 1 回だけ送ることを、
 * 切り替え後の最終状態で確認する。面 (panel-morph) の動きそのものは目で見て確かめる
 * (実時間で毎フレームを採る判定は CI でフレームが間引かれて不安定になるため置かない)。
 */
import type { Page } from "@playwright/test";
import { expect, I18N, settleAnimations, test } from "./fixtures";

const PANEL = { width: 560, height: 260 };
// 影の余白 (PanelFrame の px-6 pt-4 pb-8) + 待機中のピル (240 x 36)
const PILL_SIZE = { width: 24 + 240 + 24, height: 16 + 36 + 32 };

type Size = { width: number; height: number };
type Call = { cmd: string; args: Record<string, unknown> };

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

test("panel: OFF → ON は待機中を出し、最初の 1 回で最終の大きさを送る", async ({ page, m }) => {
  await open(page, "off");
  await expect(page.getByText(m.panel.turnOn)).toBeVisible();
  await expect.poll(async () => (await panelSizes(page)).length).toBeGreaterThan(0);
  const before = (await panelSizes(page)).length;

  await page.getByRole("button", { name: m.panel.turnOn }).click();
  await expect(page.getByText(m.panel.idle)).toBeVisible();
  await expect(page.getByTestId("panel-morph")).toBeHidden();
  // 広げる時は最初の 1 回で最終の大きさ (ピルが途中で切れない)
  await expect.poll(async () => (await panelSizes(page)).slice(before)).toEqual([PILL_SIZE]);
});

// OFF のピルの幅は文言の長さで変わる (en は送る大きさが ja と違う) ため en でも回す
test("panel: ON → OFF は OFF のピルを出し、最終の大きさを 1 回だけ送る", { tag: I18N }, async ({ page, m }) => {
  await open(page, "idle");
  await expect(page.getByText(m.panel.idle)).toBeVisible();
  await expect.poll(async () => (await panelSizes(page)).at(-1)).toEqual(PILL_SIZE);
  const before = (await panelSizes(page)).length;

  await page.getByRole("button", { name: m.panel.turnOff }).click();
  await expect(page.getByText(m.panel.turnOn)).toBeVisible();
  await expect(page.getByTestId("panel-morph")).toBeHidden();
  await settleAnimations(page);
  const to = await pillSize(page);
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
    [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === turnOn)!.click();
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
