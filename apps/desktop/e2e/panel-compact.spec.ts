/*
 * パネルのコンパクト表示 (Settings.panelStyle = "compact")。
 * 各状態の表示、set_panel_size (通常より小さく、影の余白は同じ)、クリック・ドラッグ・右クリック、
 * 通常 ⇄ コンパクトの切り替え、設定 > 一般 のスイッチを確認する。pnpm screenshots でライト・ダークを撮る (ダークは撮影だけ)。
 */
import type { Locator, Page } from "@playwright/test";
import { expect, SCREENSHOT, SCREENSHOT_ONLY, test, TIMING } from "./fixtures";

const PANEL = { width: 560, height: 260 };
const SETTINGS = { width: 840, height: 640 };
// 影の余白 (PanelFrame の px-6 pt-4 pb-8) + 36px の円
const COMPACT_SIZE = { width: 24 + 36 + 24, height: 16 + 36 + 32 };

type Call = { cmd: string; args: Record<string, unknown> };
type Size = { width: number; height: number };
type Mock = { calls: Call[]; windowCalls: Call[] };

async function open(page: Page, query: string, opts: { dark?: boolean; viewport?: Size } = {}) {
  await page.emulateMedia({ colorScheme: opts.dark ? "dark" : "light" });
  await page.setViewportSize(opts.viewport ?? PANEL);
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => "__mukuchiMock" in window);
  // 描画されてから待つ (描画前は同梱フォントの読み込みが始まっておらず、fonts.ready がすぐ解決する)
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0);
  await page.evaluate(() => document.fonts.ready);
}

function calls(page: Page, cmd: string): Promise<Call[]> {
  return page.evaluate(
    (c) => (window as unknown as { __mukuchiMock: Mock }).__mukuchiMock.calls.filter((x) => x.cmd === c),
    cmd,
  );
}

async function panelSizes(page: Page): Promise<Size[]> {
  return (await calls(page, "set_panel_size")).map((c) => c.args as Size);
}

function dragCalls(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __mukuchiMock: Mock }).__mukuchiMock.windowCalls.filter(
        (x) => x.cmd === "plugin:window|start_dragging",
      ).length,
  );
}

async function mock(page: Page, fn: string) {
  await page.evaluate(`(() => { const api = window.__mukuchiMock; ${fn} })()`);
}

/** 要素の中央で押し、dx だけ動かして離す */
async function pressMove(page: Page, target: Locator, dx: number) {
  const box = await target.boundingBox();
  if (!box) throw new Error("要素がありません");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  if (dx !== 0) await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

const compact = (page: Page) => page.getByTestId("panel-compact");

type Toggle = "turnOn" | "turnOff";

const escapeRe = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const STATES: { mock: string; state: string; button: Toggle | null; spinner: boolean; ring: boolean; error: boolean }[] = [
  { mock: "off", state: "off", button: "turnOn", spinner: false, ring: false, error: false },
  { mock: "loading", state: "loading", button: null, spinner: true, ring: false, error: false },
  { mock: "idle", state: "listening", button: "turnOff", spinner: false, ring: true, error: false },
  { mock: "speaking", state: "speaking", button: "turnOff", spinner: false, ring: true, error: false },
  { mock: "finalizing", state: "finalizing", button: "turnOff", spinner: true, ring: true, error: false },
  { mock: "error-asr", state: "error", button: "turnOn", spinner: false, ring: false, error: true },
];

test("panel compact: 各状態で円形ボタンだけを表示する", { tag: SCREENSHOT }, async ({ page, m, snap }) => {
  for (const s of STATES) {
    await open(page, `window=panel&style=compact&mock=${s.mock}`);
    await expect(compact(page)).toHaveAttribute("data-state", s.state);
    await expect(page.locator("[data-panel-style]")).toHaveAttribute("data-panel-style", "compact");
    if (s.button) await expect(page.getByRole("button", { name: m.panel[s.button] })).toBeVisible();
    else await expect(page.getByRole("button")).toHaveCount(0);
    await expect(page.getByTestId("panel-compact-spinner")).toHaveCount(s.spinner ? 1 : 0);
    await expect(page.getByTestId("panel-compact-ring")).toHaveCount(s.ring ? 1 : 0);
    await expect(page.getByTestId("panel-compact-error")).toHaveCount(s.error ? 1 : 0);
    // プレビュー・状態の文言は出さない
    await expect(page.getByTestId("preview")).toHaveCount(0);
    await expect(page.getByTestId("panel-card")).toHaveCount(0);
    await expect(page.getByTestId("panel-pill")).toHaveCount(0);
    const words = [m.panel.idle, m.panel.speaking, m.panel.finalizing, m.panel.errors.asr_stopped, m.panel.loadingModelShort];
    await expect(page.locator("body")).not.toContainText(new RegExp(words.map(escapeRe).join("|")));
    // 36px の円
    await expect(compact(page)).toHaveCSS("width", "36px");
    await expect(compact(page)).toHaveCSS("height", "36px");
    // 入力レベル (静止シナリオでも約15Hz で届く) とリングの追従を待ってから撮る
    await snap(`panel-compact-${s.mock}`, { settleMs: 400 });
  }
});

test("panel compact: 各状態 (ダーク) のスクリーンショット", { tag: SCREENSHOT_ONLY }, async ({ page, snap }) => {
  for (const s of STATES) {
    await open(page, `window=panel&style=compact&mock=${s.mock}`, { dark: true });
    await expect(compact(page)).toHaveAttribute("data-state", s.state);
    await snap(`panel-compact-${s.mock}-dark`, { settleMs: 400 });
  }
});

test("panel compact: 発話中は音量に合わせてリングが広がり、待機中は広がらない", async ({ page }) => {
  await open(page, "window=panel&style=compact&mock=speaking");
  const ring = page.getByTestId("panel-compact-ring");
  // 静止シナリオのレベルは 0.72 → 1 + 0.72 * 0.85 ≈ 1.61 倍
  await expect.poll(async () => (await ring.boundingBox())?.width ?? 0).toBeGreaterThan(40);
  await mock(page, `api.setLevel(0.06); api.setStatus({ phase: "listening" });`);
  await expect.poll(async () => (await ring.boundingBox())?.width ?? 0).toBeLessThan(29);
});

test("panel compact: エラーは赤い点で示し、内容を読み上げ用のラベルに持つ", async ({ page, ui }) => {
  await open(page, "window=panel&style=compact&mock=error-asr");
  const dot = page.getByRole("img", { name: ui.errors.asr_stopped });
  await expect(dot).toBeVisible();
  await expect(dot).toHaveCSS("background-color", "rgb(200, 50, 47)");
});

test("panel compact: 確定処理中のリングは動きを減らす設定では回さない", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize(PANEL);
  await page.goto("/?window=panel&style=compact&mock=finalizing");
  const spinner = page.getByTestId("panel-compact-spinner");
  await expect(spinner).toBeVisible();
  await expect(spinner).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(spinner).toHaveCSS("animation-name", "spin");
});

test("panel compact: set_panel_size は通常より小さく、影の余白は同じ", async ({ page, m }) => {
  await open(page, "window=panel&mock=idle");
  await expect(page.getByText(m.panel.idle)).toBeVisible();
  await expect.poll(async () => (await panelSizes(page)).length).toBeGreaterThan(0);
  const full = (await panelSizes(page)).at(-1)!;

  await open(page, "window=panel&style=compact&mock=idle");
  await expect(compact(page)).toBeVisible();
  await expect.poll(async () => (await panelSizes(page)).at(-1)).toEqual(COMPACT_SIZE);
  expect(COMPACT_SIZE.width).toBeLessThan(full.width);
  expect(COMPACT_SIZE.height).toBeLessThanOrEqual(full.height);

  const frame = await page.getByTestId("panel-frame").boundingBox();
  const circle = await compact(page).boundingBox();
  expect(circle!.x - frame!.x).toBeCloseTo(24, 0);
  expect(circle!.y - frame!.y).toBeCloseTo(16, 0);
  expect(frame!.y + frame!.height - (circle!.y + circle!.height)).toBeCloseTo(32, 0);
});

test("panel compact: アンカーの角に寄せる", async ({ page }) => {
  await open(page, "window=panel&style=compact&mock=idle&anchor=top-left");
  let circle = (await compact(page).boundingBox())!;
  expect(circle.x).toBeCloseTo(24, 0);
  expect(circle.y).toBeCloseTo(16, 0);
  await open(page, "window=panel&style=compact&mock=idle&anchor=bottom-right");
  circle = (await compact(page).boundingBox())!;
  expect(PANEL.width - (circle.x + circle.width)).toBeCloseTo(24, 0);
  expect(PANEL.height - (circle.y + circle.height)).toBeCloseTo(32, 0);
});

for (const s of [
  { name: "OFF", mock: "off", button: "turnOn" as Toggle, on: true },
  { name: "ON", mock: "idle", button: "turnOff" as Toggle, on: false },
]) {
  test(`panel compact ${s.name}: 右クリックはメニュー、4px 以上動かすとドラッグ、動かさずに離すとクリックで切り替える`, async ({ page, m }) => {
    await open(page, `window=panel&style=compact&mock=${s.mock}`);
    const button = page.getByRole("button", { name: m.panel[s.button] });
    const menus = async () => (await calls(page, "show_panel_menu")).length;
    // 右クリックで show_panel_menu を呼び、切り替え・ドラッグしない
    await button.click({ button: "right" });
    await expect.poll(menus).toBe(1);
    // 4px 以上動かすとドラッグになり、切り替えない
    await pressMove(page, button, 12);
    await expect.poll(() => dragCalls(page)).toBe(1);
    if (s.name === "OFF") {
      // 円の縁 (ボタンの外。左端から 2px 内側の枠と余白の上) からもドラッグ・右クリックできる
      const box = (await compact(page).boundingBox())!;
      const x = box.x + 2;
      const y = box.y + box.height / 2;
      await page.mouse.click(x, y, { button: "right" });
      await expect.poll(menus).toBe(2);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x - 12, y, { steps: 4 });
      await page.mouse.up();
      await expect.poll(() => dragCalls(page)).toBe(2);
    }
    expect(await calls(page, "set_listening")).toHaveLength(0);
    const drags = await dragCalls(page);
    // 閾値未満の手ぶれはクリックとして扱う
    await pressMove(page, button, 2);
    await expect.poll(async () => (await calls(page, "set_listening")).map((c) => c.args)).toEqual([{ on: s.on }]);
    expect(await dragCalls(page)).toBe(drags);
  });
}

// 面 (panel-morph) が出て消えるのを実時間で捉えるため TIMING
test("panel: 通常 → コンパクトは面が縮んでから円を出し、ウィンドウも縮む", { tag: TIMING }, async ({ page, m }) => {
  await open(page, "window=panel&mock=idle");
  await expect(page.getByText(m.panel.idle)).toBeVisible();
  await expect.poll(async () => (await panelSizes(page)).length).toBeGreaterThan(0);
  const before = (await panelSizes(page)).length;
  await mock(page, `api.invoke("update_settings", { patch: { panelStyle: "compact" } });`);
  await expect(page.getByTestId("panel-morph")).toBeVisible();
  await expect(page.getByTestId("panel-morph")).toBeHidden();
  await expect(compact(page)).toBeVisible();
  // 縮み終わってから最終の大きさを 1 回だけ送る (途中の大きさでウィンドウを縮めない)
  await expect.poll(async () => (await panelSizes(page)).slice(before)).toEqual([COMPACT_SIZE]);
});

test("panel: コンパクト → 通常は最初に最終の大きさを送る", async ({ page, m }) => {
  await open(page, "window=panel&style=compact&mock=idle");
  await expect.poll(async () => (await panelSizes(page)).at(-1)).toEqual(COMPACT_SIZE);
  const before = (await panelSizes(page)).length;
  await mock(page, `api.invoke("update_settings", { patch: { panelStyle: "full" } });`);
  await expect(page.getByText(m.panel.idle)).toBeVisible();
  await expect(page.getByTestId("panel-morph")).toBeHidden();
  const sizes = (await panelSizes(page)).slice(before);
  // 広げる時は最初の 1 回で最終の大きさ (カードが途中で切れない)
  expect(sizes.length).toBeGreaterThan(0);
  expect(sizes[0]).toEqual(sizes.at(-1));
  expect(sizes[0].width).toBeGreaterThan(COMPACT_SIZE.width);
});

test("settings 一般: コンパクト表示のスイッチで panelStyle を書く", { tag: SCREENSHOT }, async ({ page, m, snap }) => {
  await open(page, "window=settings&mock=default&category=general", { viewport: SETTINGS });
  await expect(page.getByText(m.settings.general.compactSub)).toBeVisible();
  const sw = page.getByRole("switch", { name: m.settings.general.compact });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(async () => (await calls(page, "update_settings")).map((c) => c.args))
    .toEqual([{ patch: { panelStyle: "compact" } }]);
  // スイッチのつまみの移動 (120ms) が終わってから撮る
  await snap("settings-general-compact", { settleMs: 250 });
  await sw.click();
  await expect.poll(async () => (await calls(page, "update_settings")).at(-1)?.args).toEqual({ patch: { panelStyle: "full" } });
  // 他のウィンドウ (右クリックメニュー) からの変更も反映する
  await mock(page, `api.invoke("update_settings", { patch: { panelStyle: "compact" } });`);
  await expect(sw).toHaveAttribute("aria-checked", "true");
});

test("settings 一般 (ダーク)", { tag: SCREENSHOT_ONLY }, async ({ page, m, snap }) => {
  await open(page, "window=settings&mock=default&category=general", { viewport: SETTINGS, dark: true });
  await expect(page.getByRole("switch", { name: m.settings.general.compact })).toBeVisible();
  await snap("settings-general-dark");
});
