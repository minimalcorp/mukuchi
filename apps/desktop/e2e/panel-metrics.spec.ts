/*
 * 待機中のピルと、発話で展開したカードで、ボタン行の見た目の大きさが変わらないこと
 * (角丸・ボタン・メーターの太さ・余白・行の高さ・カード下端からボタンまでの距離)。
 * メーターの長さはカードの幅に合わせて伸びるので比べない。
 */
import type { Page } from "@playwright/test";
import { expect, settleAnimations, test } from "./fixtures";

const PANEL = { width: 560, height: 360 };

async function metrics(page: Page, scenario: string) {
  await page.setViewportSize(PANEL);
  await page.goto(`/?window=panel&mock=${scenario}`);
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0);
  await page.evaluate(() => document.fonts.ready);
  const card = page.getByTestId("panel-card");
  // 展開・収縮のアニメーション (180ms) が終わってから測る (幅は途中の値を返すので、最終の幅になるまで待つ)
  await expect(card).toHaveCSS("width", scenario === "idle" ? "240px" : "360px");
  await settleAnimations(page);
  return card.evaluate((el) => {
    const row = el.lastElementChild as HTMLElement;
    const [button, meter] = Array.from(row.children) as HTMLElement[];
    const cardBox = el.getBoundingClientRect();
    const b = button.getBoundingClientRect();
    const rowStyle = getComputedStyle(row);
    return {
      radius: getComputedStyle(el).borderTopLeftRadius,
      rowHeight: row.getBoundingClientRect().height,
      padding: `${rowStyle.paddingLeft} ${rowStyle.paddingRight}`,
      gap: rowStyle.columnGap,
      button: `${b.width}x${b.height}`,
      buttonFromBottom: Math.round(cardBox.bottom - b.bottom),
      buttonFromLeft: Math.round(b.left - cardBox.left),
      meterHeight: meter.getBoundingClientRect().height,
    };
  });
}

test("展開してもボタン行の大きさ・位置は待機中のピルと同じ", async ({ page }) => {
  const idle = await metrics(page, "idle");
  for (const scenario of ["speaking", "finalizing", "inserted"]) {
    expect(await metrics(page, scenario), scenario).toEqual(idle);
  }
});
