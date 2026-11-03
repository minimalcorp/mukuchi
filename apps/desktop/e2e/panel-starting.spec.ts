/*
 * 録音開始の準備中 (phase = starting。docs/architecture.md「録音開始の準備中」)。
 * ON として扱い (OFF にできる)、待機中と同じピルで「準備中」を出してメーターを無効の見た目にすること、
 * listening に変わってもピル・ボタン・メーターが動かないこと、コンパクト表示では ON の色のまま脈動することを確認する。
 */
import type { Page } from "@playwright/test";
import { expect, I18N, settleAnimations, test } from "./fixtures";
import { findOverflows } from "./overflow";

const PANEL = { width: 560, height: 260 };
const SETTINGS = { width: 840, height: 640 };

type Call = { cmd: string; args: Record<string, unknown> };
type Box = { x: number; y: number; width: number; height: number };

async function open(page: Page, query: string, viewport = PANEL) {
  await page.setViewportSize(viewport);
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => "__mukuchiMock" in window);
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0);
  await page.evaluate(() => document.fonts.ready);
}

async function mock(page: Page, fn: string) {
  await page.evaluate(`(() => { const api = window.__mukuchiMock; ${fn} })()`);
}

function calls(page: Page, cmd: string): Promise<Call[]> {
  return page.evaluate(
    (c) => (window as unknown as { __mukuchiMock: { calls: Call[] } }).__mukuchiMock.calls.filter((x) => x.cmd === c),
    cmd,
  );
}

/** ピル・ボタン・メーターの位置と大きさ */
async function layout(page: Page): Promise<Record<string, Box | null>> {
  return {
    card: await page.getByTestId("panel-card").boundingBox(),
    button: await page.getByTestId("panel-card").getByRole("button").boundingBox(),
    meter: await page.getByTestId("level-meter").boundingBox(),
    frame: await page.getByTestId("panel-frame").boundingBox(),
  };
}

test("panel: 準備中は「準備中」を出し、メーターは音量に反応せず薄い。押すと OFF にする", { tag: I18N }, async ({ page, m }) => {
  await open(page, "window=panel&mock=starting");
  await expect(page.getByText(m.panel.starting)).toBeVisible();
  await expect(page.getByText(m.panel.idle)).toBeHidden();
  const meter = page.getByTestId("level-meter");
  await expect(meter).toHaveAttribute("data-disabled", "true");
  await expect(meter).toHaveAttribute("data-active", "false");
  await expect(meter).toHaveCSS("opacity", "0.4");
  // モックのレベル (0.72、しきい値超え) が届いてもバーは伸びない
  await expect.poll(async () => (await calls(page, "set_panel_size")).length).toBeGreaterThan(0);
  expect((await page.getByTestId("level-meter-bar").boundingBox())?.width ?? 0).toBeLessThan(1);
  // 待機中と同じ大きさのピル
  await expect(page.getByTestId("panel-card")).toHaveCSS("width", "240px");
  expect(await findOverflows(page)).toEqual([]);

  await page.getByRole("button", { name: m.panel.turnOff }).click();
  await expect.poll(async () => (await calls(page, "set_listening")).map((c) => c.args)).toEqual([{ on: false }]);
});

test("panel: 準備中 → 待機中でピル・ボタン・メーターの位置と大きさが動かない", { tag: I18N }, async ({ page, m }) => {
  await open(page, "window=panel&mock=starting");
  await expect(page.getByText(m.panel.starting)).toBeVisible();
  await settleAnimations(page);
  const before = await layout(page);
  const sizes = (await calls(page, "set_panel_size")).length;

  await mock(page, `api.setStatus({ phase: "listening" });`);
  await expect(page.getByText(m.panel.idle)).toBeVisible();
  await expect(page.getByText(m.panel.starting)).toBeHidden();
  // 同じ種類の描画内容なので、切り替えの面 (morph) は出さない
  await expect(page.getByTestId("panel-morph")).toBeHidden();
  await settleAnimations(page);
  expect(await layout(page)).toEqual(before);
  expect((await calls(page, "set_panel_size")).length).toBe(sizes);
  // メーターは有効に戻り、音量に反応する
  const meter = page.getByTestId("level-meter");
  await expect(meter).toHaveAttribute("data-disabled", "false");
  await expect(meter).toHaveCSS("opacity", "1");
  await expect.poll(async () => (await page.getByTestId("level-meter-bar").boundingBox())?.width ?? 0).toBeGreaterThan(10);
});

test("panel compact: 準備中は ON の色のまま脈動し、待機中は止まる", { tag: I18N }, async ({ page, m }) => {
  await open(page, "window=panel&style=compact&mock=starting");
  const compact = page.getByTestId("panel-compact");
  await expect(compact).toHaveAttribute("data-state", "starting");
  const button = page.getByRole("button", { name: m.panel.turnOff });
  await expect(button).toBeVisible();
  await expect(button).toHaveCSS("animation-name", "starting-pulse");
  // ON の色 (待機中と同じ背景色)
  const startingBg = await button.evaluate((el) => getComputedStyle(el).backgroundColor);

  await mock(page, `api.setStatus({ phase: "listening" });`);
  await expect(compact).toHaveAttribute("data-state", "listening");
  await expect(button).toHaveCSS("animation-name", "none");
  await expect(button).toHaveCSS("opacity", "1");
  expect(await button.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(startingBg);
});

test("panel compact: 準備中の脈動は動きを減らす設定では止め、薄くしたままにする", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, "window=panel&style=compact&mock=starting");
  const button = page.getByTestId("panel-compact").getByRole("button");
  await expect(button).toHaveCSS("animation-name", "none");
  await expect(button).toHaveCSS("opacity", "0.55");
});

test("settings 音声入力: 準備中は ON でも入力レベルを出さず、薄くする", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  const meter = page.getByTestId("input-level-meter");
  await expect(meter).toHaveAttribute("data-disabled", "false");
  await mock(page, `api.setLevel(0.9, true); api.setStatus({ phase: "starting" });`);
  await expect(meter).toHaveAttribute("data-disabled", "true");
  await expect(meter).toHaveAttribute("data-active", "false");
  await expect.poll(async () => (await page.getByTestId("input-level-meter-bar").boundingBox())?.width ?? 0).toBeLessThan(1);
});

test("panel: 準備中に話し始めてもプレビューは出し、文言は準備中のまま。準備完了 (speaking) で認識中にする", { tag: I18N }, async ({ page, m, sp }) => {
  await open(page, "window=panel&mock=starting-speaking");
  const card = page.getByTestId("panel-card");
  await expect(card).toHaveAttribute("data-expanded", "true");
  await expect(page.getByTestId("preview")).toContainText(sp.partial);
  await expect(page.getByText(m.panel.starting)).toBeVisible();
  await expect(card).not.toContainText(m.panel.speaking);
  await expect(page.getByTestId("level-meter")).toHaveAttribute("data-disabled", "true");
  expect(await findOverflows(page)).toEqual([]);

  // 発話が続いたまま準備完了
  await mock(page, `api.setStatus({ phase: "speaking" });`);
  await expect(page.getByText(m.panel.speaking)).toBeVisible();
  await expect(page.getByText(m.panel.starting)).toHaveCount(0);
  await expect(page.getByTestId("preview")).toContainText(sp.partial);
  await expect(page.getByTestId("level-meter")).toHaveAttribute("data-disabled", "false");
});

test("panel: 準備中に話し終えた発話は準備完了 (listening) で確定中になり、次の発話は認識中で出す", async ({ page, m }) => {
  await open(page, "window=panel&mock=starting-speaking");
  await expect(page.getByText(m.panel.starting)).toBeVisible();
  await mock(page, `api.setStatus({ phase: "listening" });`);
  await expect(page.getByText(m.panel.finalizing)).toBeVisible();
  await mock(page, `api.started(2); api.setStatus({ phase: "speaking" });`);
  await expect(page.getByText(m.panel.speaking)).toBeVisible();
});
