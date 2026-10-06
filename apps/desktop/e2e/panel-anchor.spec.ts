/*
 * panel のアンカー (get_panel_anchor / panel-anchor)。描画内容をアンカーの辺・角に寄せ、展開がアンカー側から広がることを確認する。
 * 展開・収縮の途中でアンカーの辺が動かないこと・set_panel_size の値は panel-collapse.spec.ts で確かめる。
 */
import type { Page } from "@playwright/test";
import { expect, SCREENSHOT_ONLY, settleAnimations, test } from "./fixtures";

const PANEL = { width: 560, height: 260 };
// 影の余白 (PanelFrame の px-6 pt-4 pb-8)
const MARGIN = { left: 24, right: 24, top: 16, bottom: 32 };

type Call = { cmd: string; args: Record<string, unknown> };
type Rect = { left: number; right: number; top: number; bottom: number };
type Horizontal = "left" | "center" | "right";
type Vertical = "top" | "bottom";

const ANCHORS: { vertical: Vertical; horizontal: Horizontal }[] = (["top", "bottom"] as const).flatMap((vertical) =>
  (["left", "center", "right"] as const).map((horizontal) => ({ vertical, horizontal })),
);

const SPEAK = `api.started(1); api.partial({ id: 1, text: "明日の打ち合わせは十時からに変更して", stableLength: 13 });`;

async function open(page: Page, query: string) {
  await page.setViewportSize(PANEL);
  await page.goto(`/?${query}`);
  // 描画されてから待つ (描画前は同梱フォントの読み込みが始まっておらず、fonts.ready がすぐ解決する)
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => "__mukuchiMock" in window);
}

async function mock(page: Page, fn: string) {
  await page.evaluate(`(() => { const api = window.__mukuchiMock; ${fn} })()`);
}

async function rect(page: Page, testId: string): Promise<Rect> {
  const box = await page.getByTestId(testId).boundingBox();
  if (!box) throw new Error(`${testId} がありません`);
  return { left: box.x, right: box.x + box.width, top: box.y, bottom: box.y + box.height };
}

test("panel anchor: 描画内容をアンカーの辺・角に寄せ、展開はアンカー側から反対へ広がる", async ({ page }) => {
  for (const { vertical, horizontal } of ANCHORS) {
    const name = `${vertical}-${horizontal}`;
    await open(page, `window=panel&mock=idle&anchor=${name}`);
    await expect(page.locator("[data-anchor]")).toHaveAttribute("data-anchor", name);
    await expect(page.getByTestId("panel-card")).toHaveCSS("width", "240px");

    const check = async () => {
      const frame = await rect(page, "panel-frame");
      const card = await rect(page, "panel-card");
      // 余白は一定 (set_panel_size の意味を保つ)。アンカー側の辺で確認する
      if (vertical === "top") expect(card.top - frame.top, name).toBeCloseTo(MARGIN.top, 0);
      else expect(frame.bottom - card.bottom, name).toBeCloseTo(MARGIN.bottom, 0);
      if (horizontal === "left") expect(card.left - frame.left, name).toBeCloseTo(MARGIN.left, 0);
      else if (horizontal === "right") expect(frame.right - card.right, name).toBeCloseTo(MARGIN.right, 0);
      else expect((card.left + card.right) / 2, name).toBeCloseTo((frame.left + frame.right) / 2, 0);
      // ブラウザ表示ではウィンドウ (viewport) 内でも同じ向きに寄せる
      if (vertical === "top") expect(frame.top, name).toBeCloseTo(0, 0);
      else expect(frame.bottom, name).toBeCloseTo(PANEL.height, 0);
      if (horizontal === "left") expect(frame.left, name).toBeCloseTo(0, 0);
      else if (horizontal === "right") expect(frame.right, name).toBeCloseTo(PANEL.width, 0);
      else expect((frame.left + frame.right) / 2, name).toBeCloseTo(PANEL.width / 2, 0);
      return card;
    };

    const pill = await check();
    // 展開中のアンカーの辺・角の動き (毎フレーム) は panel-collapse.spec.ts で確かめる。ここは展開後の配置
    await mock(page, SPEAK);
    await expect(page.getByTestId("panel-card")).toHaveCSS("width", "360px");
    await settleAnimations(page);
    const expanded = await check();
    // top は上端から下へ、bottom は下端から上へ広がる
    if (vertical === "top") expect(expanded.bottom, name).toBeGreaterThan(pill.bottom);
    else expect(expanded.top, name).toBeLessThan(pill.top);
    // 内部の順序はデザインどおり (プレビューがメーター行の上)
    const preview = await rect(page, "preview");
    const meter = await rect(page, "level-meter");
    expect(preview.bottom, name).toBeLessThanOrEqual(meter.top);
  }
});

test("panel anchor: panel-anchor で配置を切り替える", async ({ page }) => {
  await open(page, "window=panel&mock=speaking");
  const root = page.locator("[data-anchor]");
  await expect(root).toHaveAttribute("data-anchor", "bottom-center");
  await mock(page, `api.setAnchor({ horizontal: "left", vertical: "top" });`);
  await expect(root).toHaveAttribute("data-anchor", "top-left");
  const frame = await rect(page, "panel-frame");
  expect(frame.left).toBeCloseTo(0, 0);
  expect(frame.top).toBeCloseTo(0, 0);
});

test("panel anchor: 購読後に届いた panel-anchor を遅れて届く get_panel_anchor の応答で上書きしない", async ({ page, m }) => {
  // 応答を返すタイミングを clock で決める (実時間だと遅い CI では変更より先に応答が届き、確認したい順序にならない)
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await open(page, "window=panel&mock=idle&anchor=bottom-right&slow=get_panel_anchor");
  await expect(page.getByText(m.panel.idle)).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as { __mukuchiMock: { calls: Call[] } }).__mukuchiMock.calls.some((c) => c.cmd === "get_panel_anchor"),
      ),
    )
    .toBe(true);
  // get_panel_anchor (500ms 遅れ・呼ばれた時点の bottom-right を返す) の応答前にアンカーが変わる
  await mock(page, `api.setAnchor({ horizontal: "left", vertical: "top" });`);
  await expect(page.locator("[data-anchor]")).toHaveAttribute("data-anchor", "top-left");
  await page.clock.runFor(500);
  await page.waitForTimeout(100);
  await expect(page.locator("[data-anchor]")).toHaveAttribute("data-anchor", "top-left");
});

for (const name of ["top-left", "bottom-right"]) {
  test(`panel anchor ${name}: 展開表示のスクリーンショット`, { tag: SCREENSHOT_ONLY }, async ({ page, m, snap }) => {
    await open(page, `window=panel&mock=speaking&anchor=${name}`);
    await expect(page.getByText(m.panel.speaking)).toBeVisible();
    await expect(page.getByTestId("panel-card")).toHaveCSS("width", "360px");
    await settleAnimations(page);
    await snap(`panel-anchor-${name}`);
  });
}
