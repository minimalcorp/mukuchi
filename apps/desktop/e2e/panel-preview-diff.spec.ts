/*
 * プレビューの差分表示: 前回の途中表示から挿入 (緑)・書き換え (黄) された語だけを一瞬色付けし、通常の文字色へ戻す。
 * 末尾への普通の追加と消えた文字は色付け・表示しない。確定結果への置き換えも同じ差分で表示する。
 */
import type { Locator, Page } from "@playwright/test";
import { expect, SCREENSHOT, SCREENSHOTS, test, type Messages } from "./fixtures";
import { diffPreview } from "../src/windows/panel/preview-diff";

const PANEL = { width: 560, height: 260 };

// src/mock/scenarios.ts の PREVIEW_DIFF_STEPS と同じ流れ。最後は確定結果
const STEPS: { text: string; diff: [string, "insert" | "replace"][] }[] = [
  { text: "明日の打ち合わせは", diff: [] },
  { text: "明日の打ち合わせは十時から", diff: [] },
  { text: "明日の打ち合わせは十一時から", diff: [["十一時", "replace"]] },
  { text: "明日の午後の打ち合わせは十一時から", diff: [["午後の", "insert"]] },
  { text: "明日の午後の打ち合わせは十一時からへんこう", diff: [] },
  { text: "明日の午後の打ち合わせは十一時からに変更して", diff: [["に変更して", "replace"]] },
  { text: "明日の午後の打ち合わせは、十一時からに変更してください。", diff: [["、", "insert"]] },
];

// tokens.css の値 (rgb)。light: green-600 / amber-600 / gray-900、dark: green-300 / amber-300 / gray-50
const COLORS = {
  light: { insert: "rgb(12, 113, 80)", replace: "rgb(150, 99, 26)", strong: "rgb(20, 23, 29)" },
  dark: { insert: "rgb(95, 211, 160)", replace: "rgb(242, 193, 78)", strong: "rgb(245, 247, 250)" },
};

async function open(page: Page, m: Messages, scheme: "light" | "dark" = "light") {
  await page.setViewportSize(PANEL);
  await page.emulateMedia({ colorScheme: scheme });
  await page.goto("/?window=panel&mock=idle");
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => "__mukuchiMock" in window);
  await expect(page.getByText(m.panel.idle)).toBeVisible();
}

async function mock(page: Page, fn: string) {
  await page.evaluate(`(() => { const api = window.__mukuchiMock; ${fn} })()`);
}

async function show(page: Page, k: number) {
  const { text } = STEPS[k];
  if (k === STEPS.length - 1) {
    await mock(
      page,
      `api.setStatus({ phase: "finalizing" });
       api.result({ kind: "inserted", id: 1, text: ${JSON.stringify(text)}, appName: "メモ", submitted: false });
       api.setStatus({ phase: "listening" });`,
    );
  } else {
    // stableLength は表示に使わない (どの値でも差分の表示は変わらない)
    await mock(page, `api.partial({ id: 1, text: ${JSON.stringify(text)}, stableLength: 0 });`);
  }
}

/** 色付けのアニメーションを止めて、開始から ms の時点の文字色を返す */
function colorAt(span: Locator, ms: number) {
  return span.evaluate((el, t) => {
    for (const a of el.getAnimations()) {
      a.pause();
      a.currentTime = t;
    }
    return getComputedStyle(el).color;
  }, ms);
}

test("preview-diff: 単語単位で挿入・書き換え・末尾の追加を分類する", () => {
  let prev = "";
  for (const { text, diff } of STEPS) {
    const segs = diffPreview(prev, text);
    // つなげると新しいテキストに戻る (消えた文字は含まない)
    expect(segs.map((s) => s.text).join("")).toBe(text);
    expect(segs.filter((s) => s.kind !== "same").map((s) => [s.text, s.kind])).toEqual(diff);
    prev = text;
  }
  // 語の区切りが文脈で変わっても、文字が残っていれば消えた扱いにしない
  expect(diffPreview("今日はいい", "今日はいい天気")).toEqual([{ text: "今日はいい天気", kind: "same" }]);
  // 途中の語が消えただけなら色付けしない
  expect(diffPreview("明日の午後の会議", "明日の会議")).toEqual([{ text: "明日の会議", kind: "same" }]);
  // 最初の表示・同じ文字は色付けしない
  expect(diffPreview("", "あいう")).toEqual([{ text: "あいう", kind: "same" }]);
  expect(diffPreview("あいう", "あいう")).toEqual([{ text: "あいう", kind: "same" }]);
});

test("panel: 途中表示・確定のたびに前回からの差分だけを色付けする", async ({ page, m }) => {
  await open(page, m);
  const line = page.getByTestId("preview").locator("p").last();
  await mock(page, `api.setStatus({ phase: "speaking" }); api.started(1);`);
  for (let k = 0; k < STEPS.length; k++) {
    // 前回の色付けに印を付けておき、次の表示で作り直される (アニメーションが最初からになる) ことを確かめる
    await line.locator("[data-diff]").evaluateAll((els) => els.forEach((el) => el.setAttribute("data-prev", "")));
    await show(page, k);
    await expect(line).toHaveText(STEPS[k].text);
    await expect(line.locator("[data-prev]")).toHaveCount(0);
    const marked = line.locator("[data-diff]");
    await expect(marked).toHaveCount(STEPS[k].diff.length);
    for (const [i, [text, kind]] of STEPS[k].diff.entries()) {
      await expect(marked.nth(i)).toHaveText(text);
      await expect(marked.nth(i)).toHaveAttribute("data-diff", kind);
      expect(await colorAt(marked.nth(i), 0)).toBe(COLORS.light[kind]);
    }
  }
  // 未確定の末尾をグレーにする表示はしない
  await expect(page.locator(".text-fg-unstable")).toHaveCount(0);
});

// 戻り方 (待ち時間・段階的な変化) は目で見て確かめる。ここでは最終的に通常の文字色へ戻ることだけを見る
test("panel: 色付けは通常の文字色へ戻る (動きを減らす設定でも戻る)", async ({ page, m }) => {
  await open(page, m);
  const { strong } = COLORS.light;
  const color = (span: Locator) => span.evaluate((el) => getComputedStyle(el).color);
  await mock(
    page,
    `api.setStatus({ phase: "speaking" }); api.started(1);
     api.partial({ id: 1, text: ${JSON.stringify(STEPS[1].text)}, stableLength: 0 });
     api.partial({ id: 1, text: ${JSON.stringify(STEPS[2].text)}, stableLength: 0 });`,
  );
  const replaced = page.locator("[data-diff=replace]");
  await expect(replaced).toHaveText("十一時");
  await expect.poll(() => color(replaced)).toBe(strong);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await mock(page, `api.partial({ id: 1, text: ${JSON.stringify(STEPS[3].text)}, stableLength: 0 });`);
  const inserted = page.locator("[data-diff=insert]");
  await expect(inserted).toHaveText("午後の");
  await expect.poll(() => color(inserted)).toBe(strong);
});

for (const scheme of ["light", "dark"] as const) {
  test(`panel: 差分の色 (${scheme})`, { tag: SCREENSHOT }, async ({ page, m, snap }) => {
    await open(page, m, scheme);
    // 挿入と書き換えが同時に出る途中表示
    await mock(
      page,
      `api.setStatus({ phase: "speaking" }); api.started(1);
       api.partial({ id: 1, text: "明日の打ち合わせは十時からへんこう", stableLength: 0 });
       api.partial({ id: 1, text: "明日の午後の打ち合わせは十時からに変更して", stableLength: 0 });`,
    );
    const ins = page.locator("[data-diff=insert]");
    const rep = page.locator("[data-diff=replace]");
    await expect(ins).toHaveText("午後の");
    await expect(rep).toHaveText("に変更して");
    // 色付けの直後で止めて撮る
    expect(await colorAt(ins, 0)).toBe(COLORS[scheme].insert);
    expect(await colorAt(rep, 0)).toBe(COLORS[scheme].replace);
    // 撮る時は、色付けは止めたまま、パネルの展開 (180ms) が終わるのを待つ
    if (SCREENSHOTS) {
      await page.evaluate(() =>
        Promise.all(document.getAnimations().filter((a) => a.playState === "running").map((a) => a.finished)),
      );
    }
    await snap(`panel-preview-diff-${scheme}`);
  });
}
