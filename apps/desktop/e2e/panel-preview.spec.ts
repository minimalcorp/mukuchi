/*
 * パネルのプレビューが 3 行を超えても最新の文字が見えること (古い行は上に送られる) と、
 * 入力レベルのバーが届いた値まで追従すること。
 */
import type { Page } from "@playwright/test";
import { expect, SCREENSHOT, test, type Messages } from "./fixtures";

const PANEL = { width: 560, height: 360 };
// 1 行あたり約 27 文字。5 行以上になる長さ
const LONG =
  "明日の打ち合わせは十時からに変更してください。資料は前日までに共有しておきます。" +
  "会議室は三階の大会議室を予約しました。参加者は営業部と開発部の全員です。議題は来期の計画と予算についてです。";

async function open(page: Page, m: Messages, query: string) {
  await page.setViewportSize(PANEL);
  await page.goto(`/?${query}`);
  // 描画されてから待つ (描画前は同梱フォントの読み込みが始まっておらず、fonts.ready がすぐ解決する)
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => "__mukuchiMock" in window);
  // 初期値 (get_status) の表示 = イベントの購読が済んでから流す
  await expect(page.getByText(m.panel.idle)).toBeVisible();
}

async function mock(page: Page, fn: string) {
  await page.evaluate(`(() => { const api = window.__mukuchiMock; ${fn} })()`);
}

/** 最後の発話の末尾の文字が、プレビューの見えている範囲 (3 行) の中にあるか */
function lastCharVisible(page: Page) {
  return page.getByTestId("preview").evaluate((preview) => {
    const ps = preview.querySelectorAll("p");
    const last = ps[ps.length - 1];
    if (!last?.lastChild) return false;
    const range = document.createRange();
    range.selectNodeContents(last);
    const rects = [...range.getClientRects()];
    const r = rects[rects.length - 1];
    const box = preview.getBoundingClientRect();
    return r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;
  });
}

test("panel: 3 行を超える発話も途中表示・確定のたびに最新の文字が見える", { tag: SCREENSHOT }, async ({ page, m, snap }) => {
  await open(page, m, "window=panel&mock=idle");
  const preview = page.getByTestId("preview");
  for (const id of [1, 2]) {
    await mock(page, `api.setStatus({ phase: "speaking" }); api.started(${id});`);
    for (let n = 10; n < LONG.length + 10; n += 10) {
      const text = LONG.slice(0, n);
      await mock(page, `api.partial({ id: ${id}, text: ${JSON.stringify(text)}, stableLength: ${Math.max(0, text.length - 4)} });`);
      await expect(preview.locator("p").last()).toHaveText(text);
      await expect.poll(() => lastCharVisible(page)).toBe(true);
    }
    const final = `${LONG}以上${id}`;
    await mock(
      page,
      `api.setStatus({ phase: "finalizing" });
       api.result({ kind: "inserted", id: ${id}, text: ${JSON.stringify(final)}, appName: "メモ", submitted: false });
       api.setStatus({ phase: "listening" });`,
    );
    await expect(preview.locator("p").last()).toHaveText(final);
    await expect.poll(() => lastCharVisible(page)).toBe(true);
    // 3 行に収め、古い行は上に送る
    const height = await preview.evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeLessThanOrEqual(14 * 1.6 * 3 + 0.5);
  }
  await snap("panel-preview-long");
});

// 上がる・下がる速さ (平滑化の時定数) は目で見て確かめる。ここでは最終的に届いた値まで追従することだけを見る
test("panel: 入力レベルのバーは届いた値まで追従し、色は受け取った値ですぐ切り替える", async ({ page, m }) => {
  await open(page, m, "window=panel&mock=idle");
  const bar = page.getByTestId("level-meter-bar");
  const ratio = () =>
    bar.evaluate((el) => el.getBoundingClientRect().width / el.parentElement!.getBoundingClientRect().width);
  await expect.poll(ratio).toBeLessThan(0.3);

  await mock(page, "api.setLevel(0.9, true);");
  await expect.poll(ratio).toBeGreaterThan(0.85);
  await expect(page.getByTestId("level-meter")).toHaveAttribute("data-active", "true");

  await mock(page, "api.setLevel(0.1);");
  await expect(page.getByTestId("level-meter")).toHaveAttribute("data-active", "false");
  await expect.poll(ratio).toBeLessThan(0.12);
});
