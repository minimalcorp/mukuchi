/*
 * 展開・収縮でのウィンドウの大きさ (set_panel_size)。
 * 収縮中にウィンドウを少しずつ縮めると、ネイティブのウィンドウの変更と WebView の描画がずれてカードが揺れるため、
 * 展開・収縮とも set_panel_size は 1 回 (展開は開始時、収縮はアニメーションの終了後) であることを、
 * 終わった後の送った値の一覧で確認する。途中のカードの位置 (アンカーの辺が動かないこと) は目で見て確かめる
 * (実時間で毎フレームを採る判定は CI でフレームが間引かれて不安定になるため置かない)。
 */
import type { Page } from "@playwright/test";
import { expect, test, type Messages } from "./fixtures";

const PANEL = { width: 560, height: 360 };
const PILL_SIZE = { width: 24 + 240 + 24, height: 16 + 36 + 32 };

type Size = { width: number; height: number };

const SPEAK = `api.setStatus({ phase: "speaking" }); api.started(1); api.partial({ id: 1, text: "明日の打ち合わせは十時からに変更して", stableLength: 13 });`;
// 入力できた最終結果は 750ms 表示してから消え、カードがピルに戻る (live のシナリオなので時間で消える)
const INSERT = `api.setStatus({ phase: "finalizing" }); api.result({ kind: "inserted", id: 1, text: "明日の打ち合わせは十時からに変更してください。", appName: "メモ", submitted: false }); api.setStatus({ phase: "listening" });`;

async function open(page: Page, m: Messages, anchor: string) {
  await page.setViewportSize(PANEL);
  // default は live (確定結果を時間で消す)。オフで始まるので待機中にする (発話を流す onListen は呼ばない)
  await page.goto(`/?window=panel&mock=default&anchor=${anchor}`);
  await page.waitForFunction(() => "__mukuchiMock" in window);
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0);
  await page.evaluate(() => document.fonts.ready);
  await mock(page, `api.setStatus({ phase: "listening" });`);
  await expect(page.getByText(m.panel.idle)).toBeVisible();
  await expect.poll(async () => (await sizes(page)).at(-1)).toEqual(PILL_SIZE);
}

async function mock(page: Page, fn: string) {
  await page.evaluate(`(() => { const api = window.__mukuchiMock; ${fn} })()`);
}

function sizes(page: Page): Promise<Size[]> {
  return page.evaluate(() =>
    (window as unknown as { __mukuchiMock: { calls: { cmd: string; args: Size }[] } }).__mukuchiMock.calls
      .filter((c) => c.cmd === "set_panel_size")
      .map((c) => c.args),
  );
}

/** 発話で展開し、展開し終わるまで待つ */
async function expand(page: Page) {
  await mock(page, SPEAK);
  const card = page.getByTestId("panel-card");
  await expect(card).toHaveCSS("width", "360px");
  await expect(card).toHaveAttribute("data-expanded", "true");
}

/** 最終結果を出し、ピルへ縮み終わるまで待つ (収縮の終わりは data-collapsing が false に戻ること) */
async function collapse(page: Page) {
  await mock(page, INSERT);
  const card = page.getByTestId("panel-card");
  await expect(card).toHaveAttribute("data-expanded", "false");
  await expect(card).toHaveAttribute("data-collapsing", "false");
  await expect(card).toHaveCSS("width", "240px");
}

// 既定 (下中央) と、縦横とも逆向きの角 (左上)。静的な配置は 6 通りとも panel-anchor.spec.ts で確かめる
for (const anchor of ["bottom-center", "top-left"]) {
  test(`panel ${anchor}: 展開は最初に、収縮は終わってから最終の大きさを 1 回ずつ送り、ピルは元の位置に戻る`, async ({ page, m }) => {
    await open(page, m, anchor);
    const idle = await page.getByTestId("panel-card").boundingBox();

    let before = (await sizes(page)).length;
    await expand(page);
    const frame = (await page.getByTestId("panel-frame").boundingBox())!;
    // 展開は最初に最終の大きさを 1 回だけ送る
    await expect
      .poll(async () => (await sizes(page)).slice(before))
      .toEqual([{ width: Math.ceil(frame.width / 2) * 2, height: Math.ceil(frame.height) }]);

    before = (await sizes(page)).length;
    await collapse(page);
    // 収縮は終わってから最終の大きさを 1 回だけ送る (途中の大きさを送らない)
    await expect.poll(async () => (await sizes(page)).slice(before)).toEqual([PILL_SIZE]);
    // 待機中のピルは展開前と同じ位置・大きさに戻る
    expect(await page.getByTestId("panel-card").boundingBox()).toEqual(idle);
  });
}

test("panel: 動きを減らす設定では、展開・収縮のトランジションをせず、最終の大きさを 1 回送る", async ({ page, m }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, m, "bottom-center");
  // 幅・高さのトランジションを外す (motion-reduce:transition-none)
  await expect(page.getByTestId("panel-card")).toHaveCSS("transition-property", "none");
  await expand(page);
  // 展開の大きさ (影の余白 + 360px) が届いてから数える (送るのは描画の後なので、カードの幅より遅れて届く)
  await expect.poll(async () => (await sizes(page)).at(-1)?.width).toBe(24 + 360 + 24);
  const before = (await sizes(page)).length;
  await collapse(page);
  await expect.poll(async () => (await sizes(page)).slice(before)).toEqual([PILL_SIZE]);
});
