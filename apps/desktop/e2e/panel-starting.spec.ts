/*
 * 録音開始の準備中 (phase = starting) と無音 (no_input)。docs/architecture.md「録音開始の準備中」。
 * 「待機中 = マイク入力が有効」に揃え、準備中・無音は OFF と同じ系統のピルで出すこと (準備中は OFF と同じ幅で面のアニメーションなし)、
 * listening になった時に面 (panel-morph) が待機中のピル (240px) へ広がること、準備中に話し始めても広げないこと、
 * 無音のピルからサウンド設定を開けること、コンパクト表示は OFF の色 (準備中は脈動・無音は amber の点) で出すこと、
 * OFF→ON・ON の間の開き直しの扱いを確認する。
 */
import type { Page } from "@playwright/test";
import { expect, I18N, settleAnimations, test, TIMING } from "./fixtures";
import { findOverflows } from "./overflow";

const PANEL = { width: 560, height: 260 };
const SETTINGS = { width: 840, height: 640 };

type Call = { cmd: string; args: Record<string, unknown> };
type Size = { width: number; height: number };

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

async function sizeOf(page: Page, testId: string): Promise<Size> {
  const box = (await page.getByTestId(testId).boundingBox())!;
  return { width: box.width, height: box.height };
}

/** fn を実行してから 600ms、または面 (morph) が出て消えるまで、毎フレームの面の大きさ (出ていない時は null) を記録する */
function recordMorph(page: Page, fn: string): Promise<(Size | null)[]> {
  return page.evaluate(async (fn) => {
    const api = (window as unknown as { __mukuchiMock: unknown }).__mukuchiMock;
    const morph = document.querySelector<HTMLElement>('[data-testid="panel-morph"]')!;
    new Function("api", fn)(api);
    const out: ({ width: number; height: number } | null)[] = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 600) {
      await new Promise((r) => requestAnimationFrame(r));
      const rect = morph.getBoundingClientRect();
      out.push(morph.hidden ? null : { width: rect.width, height: rect.height });
      if (out.some((f) => f) && morph.hidden) break;
    }
    return out;
  }, fn);
}

test("panel: 準備中は OFF と同じ形・幅のピルで「準備中」を出し、押すと OFF にする", { tag: I18N }, async ({ page, m }) => {
  await open(page, "window=panel&mock=off");
  await expect(page.getByText(m.panel.turnOn)).toBeVisible();
  await settleAnimations(page);
  const off = await sizeOf(page, "panel-pill");
  await expect.poll(async () => (await calls(page, "set_panel_size")).length).toBeGreaterThan(0);
  const sizes = (await calls(page, "set_panel_size")).length;

  await mock(page, `api.setStatus({ phase: "starting" });`);
  await expect(page.getByText(m.panel.starting)).toBeVisible();
  await expect(page.getByText(m.panel.turnOn)).toBeHidden();
  await expect(page.getByText(m.panel.idle)).toHaveCount(0);
  // 待機中のメーターは出さない (レベル 0.72 が届いても話せるように見せない)
  await expect(page.getByTestId("level-meter")).toHaveCount(0);
  await expect(page.getByTestId("panel-card")).toHaveCount(0);
  await expect(page.getByTestId("panel-pill")).toHaveAttribute("data-state", "starting");
  await settleAnimations(page);
  expect(await sizeOf(page, "panel-pill")).toEqual(off);
  // ウィンドウの大きさも変えない
  expect((await calls(page, "set_panel_size")).length).toBe(sizes);
  expect(await findOverflows(page)).toEqual([]);

  await page.getByRole("button", { name: m.panel.turnOff }).click();
  await expect.poll(async () => (await calls(page, "set_listening")).map((c) => c.args)).toEqual([{ on: false }]);
});

test("panel: 準備中のアイコンは回転し、動きを減らす設定では止める", async ({ page }) => {
  await open(page, "window=panel&mock=starting");
  await expect(page.getByTestId("panel-starting-icon")).toHaveCSS("animation-name", "spin");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.getByTestId("panel-starting-icon")).toHaveCSS("animation-name", "none");
});

// 面 (panel-morph) が出る・出ないを毎フレーム実時間で採取するため TIMING。OFF のピルの幅は言語で変わるため en でも回す
test("panel: OFF → 準備中は面を動かさず、準備中 → 待機中で面が 240px のピルへ広がる", { tag: [TIMING, I18N] }, async ({ page, m }) => {
  await open(page, "window=panel&mock=off");
  await expect(page.getByText(m.panel.turnOn)).toBeVisible();
  await settleAnimations(page);
  const off = await sizeOf(page, "panel-pill");

  const toStarting = await recordMorph(page, `api.setStatus({ phase: "starting" });`);
  expect(toStarting.every((f) => f === null)).toBe(true);
  await expect(page.getByText(m.panel.starting)).toBeVisible();

  const toListening = await recordMorph(page, `api.setStatus({ phase: "listening" });`);
  const morphing = toListening.filter((f): f is Size => f !== null);
  expect(morphing.length).toBeGreaterThan(2);
  expect(morphing[0].width).toBeGreaterThanOrEqual(off.width - 1);
  expect(morphing[0].width).toBeLessThan(240);
  expect(Math.abs(morphing.at(-1)!.width - 240)).toBeLessThan(8);
  expect(toListening.at(-1)).toBeNull();
  await expect(page.getByText(m.panel.idle)).toBeVisible();
  await expect(page.getByTestId("panel-card")).toHaveCSS("width", "240px");
});

test("panel: 準備中に話し始めても広げず、準備完了 (speaking) で展開したカードを出す", { tag: I18N }, async ({ page, m, sp }) => {
  await open(page, "window=panel&mock=starting-speaking");
  await expect(page.getByText(m.panel.starting)).toBeVisible();
  // 発話の途中表示が届いても準備中のピルのまま
  await expect(page.getByTestId("panel-card")).toHaveCount(0);
  await expect(page.getByTestId("preview")).toHaveCount(0);
  await expect(page.getByText(sp.partial)).toHaveCount(0);

  // 発話が続いたまま準備完了
  await mock(page, `api.setStatus({ phase: "speaking" });`);
  const card = page.getByTestId("panel-card");
  await expect(card).toHaveAttribute("data-expanded", "true");
  await expect(page.getByText(m.panel.speaking)).toBeVisible();
  await expect(page.getByTestId("preview")).toContainText(sp.partial);
  await expect(page.getByText(m.panel.starting)).toHaveCount(0);
  await expect(card).toHaveCSS("width", "360px");
  expect(await findOverflows(page)).toEqual([]);
});

test("panel: 準備中に話し終えた発話は準備完了 (listening) で確定中になり、次の発話は認識中で出す", async ({ page, m }) => {
  await open(page, "window=panel&mock=starting-speaking");
  await expect(page.getByText(m.panel.starting)).toBeVisible();
  await mock(page, `api.setStatus({ phase: "listening" });`);
  await expect(page.getByText(m.panel.finalizing)).toBeVisible();
  await mock(page, `api.started(2); api.setStatus({ phase: "speaking" });`);
  await expect(page.getByText(m.panel.speaking)).toBeVisible();
});

test("panel: 無音は OFF ボタン・文言・サウンド設定のピルで出し、サウンド設定を開ける", { tag: I18N }, async ({ page, m }) => {
  await open(page, "window=panel&mock=no-input");
  const pill = page.getByTestId("panel-pill");
  await expect(pill).toHaveAttribute("data-state", "no_input");
  await expect(page.getByRole("status")).toHaveText(m.panel.noInput);
  await expect(page.getByTestId("level-meter")).toHaveCount(0);
  await expect(page.getByText(m.panel.idle)).toHaveCount(0);
  expect(await findOverflows(page)).toEqual([]);

  await page.getByRole("button", { name: m.panel.soundSettings }).click();
  await expect.poll(async () => (await calls(page, "open_system_settings")).map((c) => c.args)).toEqual([{ pane: "sound_input" }]);
  await page.getByRole("button", { name: m.panel.turnOff }).click();
  await expect.poll(async () => (await calls(page, "set_listening")).map((c) => c.args)).toEqual([{ on: false }]);
});

// 面を毎フレーム実時間で採取するため TIMING
test("panel: 準備中 → 無音は面がピルの幅を変え、無音 → 待機中は 240px のピルへ変わる", { tag: TIMING }, async ({ page, m }) => {
  await open(page, "window=panel&mock=starting");
  await expect(page.getByText(m.panel.starting)).toBeVisible();
  await settleAnimations(page);

  const toNoInput = await recordMorph(page, `api.setStatus({ phase: "no_input" });`);
  expect(toNoInput.filter((f) => f).length).toBeGreaterThan(2);
  await expect(page.getByText(m.panel.noInput)).toBeVisible();

  const toListening = await recordMorph(page, `api.setStatus({ phase: "listening" });`);
  const morphing = toListening.filter((f): f is Size => f !== null);
  expect(morphing.length).toBeGreaterThan(2);
  expect(Math.abs(morphing.at(-1)!.width - 240)).toBeLessThan(8);
  await expect(page.getByText(m.panel.idle)).toBeVisible();
});

test("panel: ON の間の開き直し (待機中 → 準備中) は準備中のピルに縮み、結果の表示中でも広げない", async ({ page, m, sp }) => {
  await open(page, "window=panel&mock=idle");
  await expect(page.getByText(m.panel.idle)).toBeVisible();
  await mock(page, `api.setStatus({ phase: "starting" });`);
  await expect(page.getByText(m.panel.starting)).toBeVisible();
  await expect(page.getByTestId("panel-card")).toHaveCount(0);

  // 確定結果の表示中 (モックは時間で消さない) に開き直しても準備中のピル。準備ができたら結果を出す
  await mock(page, `api.setStatus({ phase: "listening" });
    api.started(1);
    api.result({ kind: "inserted", id: 1, text: ${JSON.stringify(sp.text)}, appName: "メモ", submitted: false });`);
  await expect(page.getByTestId("panel-card")).toHaveAttribute("data-expanded", "true");
  await mock(page, `api.setStatus({ phase: "starting" });`);
  await expect(page.getByText(m.panel.starting)).toBeVisible();
  await expect(page.getByTestId("preview")).toHaveCount(0);
  await mock(page, `api.setStatus({ phase: "listening" });`);
  await expect(page.getByTestId("preview")).toContainText(sp.text);
});

// Rust は OFF にしても確定処理中は phase を finalizing (on = false) にする。phase だけでは OFF→ON と分からない遷移
for (const late of [false, true]) {
  test(`panel: OFF 後の確定処理中 (finalizing・on = false) → 準備中は OFF→ON として前回の結果を引き継がない${late ? " (結果が ON の後に届く)" : ""}`, async ({ page, m, sp }) => {
    await open(page, "window=panel&mock=idle");
    await mock(page, `api.started(1);
      api.partial({ id: 1, text: ${JSON.stringify(sp.partial)}, stableLength: 0 });
      api.setStatus({ phase: "speaking" });`);
    await expect(page.getByTestId("preview")).toContainText(sp.partial);
    // 発話中に OFF (話し終わりの無音待ち中の OFF・1回ずつ聞き取るの確定後の自動 OFF)。確定処理の間は表示が残り、ボタンは OFF
    await mock(page, `api.setStatus({ phase: "finalizing", on: false });`);
    await expect(page.getByTestId("preview")).toContainText(sp.partial);
    await expect(page.getByRole("button", { name: m.panel.turnOn })).toBeVisible();
    const result = `api.result({ kind: "inserted", id: 1, text: ${JSON.stringify(sp.text)}, appName: "メモ", submitted: false });`;
    if (!late) {
      await mock(page, result);
      await expect(page.getByTestId("preview")).toContainText(sp.text);
    }
    // 確定処理中のまま ON (finalizing → starting)
    await mock(page, `api.setStatus({ phase: "starting", on: true });`);
    await expect(page.getByText(m.panel.starting)).toBeVisible();
    if (late) await mock(page, result);
    await mock(page, `api.setStatus({ phase: "listening" });`);
    const card = page.getByTestId("panel-card");
    await expect(page.getByText(m.panel.idle)).toBeVisible();
    await expect(card).toHaveAttribute("data-expanded", "false");
    await expect(card).not.toContainText(sp.text);
    // 新しい発話は出す
    await mock(page, `api.started(2); api.setStatus({ phase: "speaking" });
      api.partial({ id: 2, text: ${JSON.stringify(sp.partial)}, stableLength: 0 });`);
    await expect(card).toHaveAttribute("data-expanded", "true");
    await expect(page.getByTestId("preview")).toContainText(sp.partial);
    await expect(page.getByTestId("preview")).not.toContainText(sp.text);
  });
}

test("panel compact: 準備中は OFF の色で脈動し、待機中は ON の色で止まる", { tag: I18N }, async ({ page, m }) => {
  await open(page, "window=panel&style=compact&mock=off");
  const offBg = await page
    .getByRole("button", { name: m.panel.turnOn })
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  await mock(page, `api.setStatus({ phase: "starting" });`);
  const compact = page.getByTestId("panel-compact");
  await expect(compact).toHaveAttribute("data-state", "starting");
  const button = page.getByRole("button", { name: m.panel.turnOff });
  await expect(button).toBeVisible();
  await expect(button).toHaveCSS("animation-name", "starting-pulse");
  expect(await button.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(offBg);
  // 入力レベルのリングは出さない
  await expect(page.getByTestId("panel-compact-ring")).toHaveCount(0);

  await mock(page, `api.setStatus({ phase: "listening" });`);
  await expect(compact).toHaveAttribute("data-state", "listening");
  await expect(button).toHaveCSS("animation-name", "none");
  await expect(button).toHaveCSS("opacity", "1");
  // 背景色は transition で変わるので待つ
  await expect.poll(() => button.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(offBg);
  await expect(page.getByTestId("panel-compact-ring")).toHaveCount(1);
});

test("panel compact: 準備中の脈動は動きを減らす設定では止め、薄くしたままにする", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, "window=panel&style=compact&mock=starting");
  const button = page.getByTestId("panel-compact").getByRole("button");
  await expect(button).toHaveCSS("animation-name", "none");
  await expect(button).toHaveCSS("opacity", "0.55");
});

test("panel compact: 無音は OFF の色に amber の点を付け、内容を読み上げ用のラベルに持つ", { tag: I18N }, async ({ page, m }) => {
  await open(page, "window=panel&style=compact&mock=off");
  const offBg = await page
    .getByRole("button", { name: m.panel.turnOn })
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  await mock(page, `api.setStatus({ phase: "no_input" });`);
  await expect(page.getByTestId("panel-compact")).toHaveAttribute("data-state", "no_input");
  const button = page.getByRole("button", { name: m.panel.turnOff });
  await expect(button).toHaveCSS("animation-name", "none");
  expect(await button.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(offBg);
  const dot = page.getByRole("img", { name: m.panel.noInput });
  await expect(dot).toBeVisible();
  // amber-500 (#b7791f)
  await expect(dot).toHaveCSS("background-color", "rgb(183, 121, 31)");
  await expect(page.getByTestId("panel-compact-error")).toHaveCount(0);
  // 文言は出さない
  await expect(page.locator("body")).not.toContainText(m.panel.noInput);
});

test("settings 音声入力: 準備中は ON でも入力レベルを出さず、薄くする", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  const meter = page.getByTestId("input-level-meter");
  await expect(meter).toHaveAttribute("data-disabled", "false");
  await mock(page, `api.setLevel(0.9, true); api.setStatus({ phase: "starting" });`);
  await expect(meter).toHaveAttribute("data-disabled", "true");
  await expect(meter).toHaveAttribute("data-active", "false");
  await expect.poll(async () => (await page.getByTestId("input-level-meter-bar").boundingBox())?.width ?? 0).toBeLessThan(1);
  await expect(page.getByTestId("input-level-no-input")).toHaveCount(0);
});

test("settings 音声入力: 無音はメーターを無効にし、確かめる所とサウンド設定のボタンを出す", { tag: I18N }, async ({ page, m }) => {
  await open(page, "window=settings&mock=no-input&category=voice", SETTINGS);
  const meter = page.getByTestId("input-level-meter");
  await expect(meter).toHaveAttribute("data-disabled", "true");
  await expect(meter).toHaveAttribute("data-active", "false");
  await expect.poll(async () => (await page.getByTestId("input-level-meter-bar").boundingBox())?.width ?? 0).toBeLessThan(1);
  const notice = page.getByTestId("input-level-no-input");
  await expect(notice).toContainText(m.settings.voice.noInput);
  expect(await findOverflows(page)).toEqual([]);
  await notice.getByRole("button", { name: m.panel.soundSettings }).click();
  await expect.poll(async () => (await calls(page, "open_system_settings")).map((c) => c.args)).toEqual([{ pane: "sound_input" }]);

  // 音が届いたら (listening) 案内を消してレベルを出す
  await mock(page, `api.setStatus({ phase: "listening" });`);
  await expect(notice).toHaveCount(0);
  await expect(meter).toHaveAttribute("data-disabled", "false");
});
