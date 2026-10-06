/*
 * 展開・収縮のアニメーション中の、カードの位置とウィンドウの大きさ (set_panel_size)。
 * 収縮中にウィンドウを少しずつ縮めると、ネイティブのウィンドウの変更と WebView の描画がずれてカードが揺れるため、
 * 展開・収縮とも set_panel_size は 1 回 (展開は開始時、収縮はアニメーションの終了後) で、
 * アニメーション中はアンカーの辺が動かないことを毎フレーム確認する。
 */
import type { Page } from "@playwright/test";
import { expect, test, type Messages } from "./fixtures";

const PANEL = { width: 560, height: 360 };
const PILL_SIZE = { width: 24 + 240 + 24, height: 16 + 36 + 32 };

type Size = { width: number; height: number };
type Sample = {
  t: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  frame: Size;
  opacity: number;
  sizes: Size[];
};

const SPEAK = `api.setStatus({ phase: "speaking" }); api.started(1); api.partial({ id: 1, text: "明日の打ち合わせは十時からに変更して", stableLength: 13 });`;
// 入力できた最終結果は 750ms 表示してから消え、カードがピルに戻る (live のシナリオなので時間で消える)
const INSERT = `api.setStatus({ phase: "finalizing" }); api.result({ kind: "inserted", id: 1, text: "明日の打ち合わせは十時からに変更してください。", appName: "メモ" }); api.setStatus({ phase: "listening" });`;

async function open(page: Page, m: Messages, anchor: string) {
  await page.setViewportSize(PANEL);
  // default は live (確定結果を時間で消す)。オフで始まるので待機中にする (発話を流す onListen は呼ばない)
  await page.goto(`/?window=panel&mock=default&anchor=${anchor}`);
  await page.waitForFunction(() => "__mukuchiMock" in window);
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => (window as unknown as { __mukuchiMock: { setStatus: (p: object) => void } }).__mukuchiMock.setStatus({ phase: "listening" }));
  await expect(page.getByText(m.panel.idle)).toBeVisible();
  await expect.poll(async () => (await sizes(page)).at(-1)).toEqual(PILL_SIZE);
}

function sizes(page: Page): Promise<Size[]> {
  return page.evaluate(() =>
    (window as unknown as { __mukuchiMock: { calls: { cmd: string; args: Size }[] } }).__mukuchiMock.calls
      .filter((c) => c.cmd === "set_panel_size")
      .map((c) => c.args),
  );
}

/** fn を実行し、until が真になってから 150ms 後まで、毎フレームのカード・プレビュー・set_panel_size を記録する */
function record(page: Page, fn: string, until: string, timeout = 2000): Promise<Sample[]> {
  return page.evaluate(
    async ({ fn, until, timeout }) => {
      type Call = { cmd: string; args: { width: number; height: number } };
      const api = (window as unknown as { __mukuchiMock: { calls: Call[] } }).__mukuchiMock;
      const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
      const base = api.calls.length;
      new Function("api", fn)(api);
      const done = new Function("api", `return ${until}`) as (a: unknown) => boolean;
      const out: Sample[] = [];
      const t0 = performance.now();
      let doneAt: number | null = null;
      while (performance.now() - t0 < timeout) {
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now() - t0;
        const c = q("panel-card").getBoundingClientRect();
        const f = q("panel-frame").getBoundingClientRect();
        out.push({
          t: now,
          left: c.left,
          right: c.right,
          top: c.top,
          bottom: c.bottom,
          frame: { width: f.width, height: f.height },
          opacity: Number(getComputedStyle(q("panel-preview-clip")).opacity),
          sizes: api.calls.slice(base).filter((x) => x.cmd === "set_panel_size").map((x) => x.args),
        });
        if (doneAt == null && done(api)) doneAt = now;
        if (doneAt != null && now - doneAt > 150) break;
      }
      return out;
    },
    { fn, until, timeout },
  );
}

const CARD_IS = (width: number) =>
  `document.querySelector('[data-testid="panel-card"]').getBoundingClientRect().width === ${width}`;

const anchored = (s: Sample, vertical: string, horizontal: string) => ({
  x: horizontal === "left" ? s.left : horizontal === "right" ? s.right : (s.left + s.right) / 2,
  y: vertical === "top" ? s.top : s.bottom,
});

for (const anchor of ["bottom-center", "top-center", "top-left", "bottom-right"]) {
  const [vertical, horizontal] = anchor.split("-");

  test(`panel ${anchor}: 展開・収縮中はアンカーの辺が動かず、set_panel_size は 1 回だけ`, async ({ page, m }) => {
    await open(page, m, anchor);
    const idle = await page.getByTestId("panel-card").boundingBox();

    const expand = await record(page, SPEAK, CARD_IS(360));
    const expanded = expand.at(-1)!;
    // 展開は最初に最終の大きさを 1 回だけ送る
    expect(expanded.sizes).toHaveLength(1);
    expect(expanded.sizes[0]).toEqual({ width: Math.ceil(expanded.frame.width / 2) * 2, height: Math.ceil(expanded.frame.height) });

    const collapse = await record(page, INSERT, `${CARD_IS(240)} && api.calls.at(-1)?.cmd === "set_panel_size"`, 3000);
    const last = collapse.at(-1)!;
    // 収縮は終わってから最終の大きさを 1 回だけ送る (途中の大きさを送らない)
    expect(last.sizes).toEqual([PILL_SIZE]);
    // ウィンドウ (描画内容) の大きさは、カードが縮み終わるまで展開時のまま。変わるのは縮み終わった後の 1 回だけ
    for (const s of collapse) {
      if (s.right - s.left > 240.01 || s.bottom - s.top > 36.01) expect(s.frame).toEqual(expanded.frame);
    }
    const frames = collapse.map((s) => `${s.frame.width}x${s.frame.height}`).filter((f, i, a) => i === 0 || f !== a[i - 1]);
    expect(frames).toEqual([`${expanded.frame.width}x${expanded.frame.height}`, `${PILL_SIZE.width}x${PILL_SIZE.height}`]);

    // 途中の大きさを経由して (アニメーションして) 縮み、幅・高さは単調に減る
    const widths = collapse.map((s) => s.right - s.left);
    const heights = collapse.map((s) => s.bottom - s.top);
    expect(widths.some((w) => w > 240.5 && w < 359.5)).toBe(true);
    for (let i = 1; i < collapse.length; i++) {
      expect(widths[i]).toBeLessThanOrEqual(widths[i - 1] + 0.01);
      expect(heights[i]).toBeLessThanOrEqual(heights[i - 1] + 0.01);
    }

    // 最終結果の文字は出したまま、縮み終わる前に消える (80ms)
    const shrinkStart = collapse.findIndex((s) => s.right - s.left < 359.5);
    expect(collapse[Math.max(0, shrinkStart - 1)].opacity).toBeGreaterThan(0.9);
    const hidden = collapse.findIndex((s) => s.opacity === 0);
    expect(hidden).toBeGreaterThan(-1);
    expect(hidden).toBeLessThan(collapse.findIndex((s) => s.right - s.left <= 240.01));

    // アンカーの辺・角は展開・収縮・ウィンドウの大きさの変更の前後を通して ±0.5px 以内
    const start = anchored(expand[0], vertical, horizontal);
    for (const s of [...expand, ...collapse]) {
      const p = anchored(s, vertical, horizontal);
      expect(Math.abs(p.x - start.x)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(p.y - start.y)).toBeLessThanOrEqual(0.5);
    }
    // 待機中のピルは展開前と同じ位置・大きさに戻る
    expect(await page.getByTestId("panel-card").boundingBox()).toEqual(idle);
  });
}

test("panel: 収縮の途中で再び展開した時は、展開時の大きさのまま送り直さない", async ({ page, m }) => {
  await open(page, m, "bottom-center");
  await record(page, SPEAK, CARD_IS(360));
  const before = (await sizes(page)).length;
  // 消えてピルへ戻り始めた直後に次の発話が始まる
  const samples = await record(
    page,
    `${INSERT}
     const wait = () => {
       // 縮み始めてから (幅 320px 未満になってから) 次の発話を始める
       if (document.querySelector('[data-testid="panel-card"]').getBoundingClientRect().width >= 320) return requestAnimationFrame(wait);
       ${SPEAK.replaceAll("1", "2")}
       window.__reexpanded = true;
     };
     wait();`,
    `window.__reexpanded && ${CARD_IS(360)} && document.querySelector('[data-testid="panel-card"]').dataset.collapsing === "false"`,
    3000,
  );
  expect(samples.some((s) => s.right - s.left < 359.5)).toBe(true);
  // 大きさは展開時のまま (高さはプレビューの行数で変わりうるので、送ったとしても幅は展開時の幅)
  const sent = (await sizes(page)).slice(before);
  expect(sent.every((s) => s.width === 408)).toBe(true);
});

test("panel: 動きを減らす設定では、アニメーションせずにすぐ最終の大きさを 1 回送る", async ({ page, m }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, m, "bottom-center");
  await record(page, SPEAK, CARD_IS(360));
  const collapse = await record(page, INSERT, `${CARD_IS(240)} && api.calls.at(-1)?.cmd === "set_panel_size"`, 3000);
  expect(collapse.at(-1)!.sizes).toEqual([PILL_SIZE]);
  const widths = collapse.map((s) => s.right - s.left);
  expect(widths.every((w) => w > 359.5 || w < 240.5)).toBe(true);
});
