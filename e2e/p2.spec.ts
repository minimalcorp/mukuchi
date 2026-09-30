/*
 * P2 (実データ接続) で増えたやり取りの確認: set_panel_size、settings-navigate、未実装 command、
 * 購読と初期値取得の順序、ダークモードの切り替え。
 */
import { expect, test, type Page } from "@playwright/test";

const PANEL = { width: 560, height: 260 };
const SETUP = { width: 640, height: 520 };
const SETTINGS = { width: 840, height: 640 };

type Call = { cmd: string; args: Record<string, unknown> };
type Size = { width: number; height: number };

async function open(page: Page, query: string, viewport: Size) {
  await page.setViewportSize(viewport);
  await page.goto(`/?${query}`);
  await page.evaluate(() => document.fonts.ready);
  // モックの API (main.tsx の boot 内で入る) が使えるまで待つ
  await page.waitForFunction(() => "__mukuchiMock" in window);
}

function calls(page: Page): Promise<Call[]> {
  return page.evaluate(() => (window as unknown as { __mukuchiMock: { calls: Call[] } }).__mukuchiMock.calls);
}

async function panelSizes(page: Page): Promise<Size[]> {
  return (await calls(page)).filter((c) => c.cmd === "set_panel_size").map((c) => c.args as Size);
}

async function frameSize(page: Page): Promise<Size> {
  const box = await page.getByTestId("panel-frame").boundingBox();
  if (!box) throw new Error("panel-frame がありません");
  return { width: Math.ceil(box.width), height: Math.ceil(box.height) };
}

/** モックの API をページ内で呼ぶ */
async function mock(page: Page, fn: string) {
  await page.evaluate(`(() => { const api = window.__mukuchiMock; ${fn} })()`);
}

// ---------- set_panel_size ----------

test("panel: 描画内容 (影の余白込み) の大きさを set_panel_size で送る", async ({ page }) => {
  await open(page, "window=panel&mock=off", PANEL);
  await expect(page.getByRole("button", { name: "音声入力をオン" })).toBeVisible();
  const size = await frameSize(page);
  await expect.poll(async () => (await panelSizes(page)).at(-1)).toEqual(size);
  // 余白 (左右 24px・上 16px・下 32px) を含む
  const pill = await page.getByRole("button", { name: "音声入力をオン" }).locator("..").boundingBox();
  expect(size.width).toBeGreaterThanOrEqual(Math.ceil(pill!.width) + 48);
  expect(size.height).toBeGreaterThanOrEqual(Math.ceil(pill!.height) + 48);
});

test("panel: 展開は開始時点で最終の大きさを送り、収縮はカードに合わせて縮める", async ({ page }) => {
  await open(page, "window=panel&mock=idle", PANEL);
  await expect(page.getByText("待機中")).toBeVisible();
  const pill = await frameSize(page);
  await expect.poll(async () => (await panelSizes(page)).at(-1)).toEqual(pill);
  const before = (await panelSizes(page)).length;

  // 発話が始まって展開する
  await mock(page, `api.started(1); api.partial({ id: 1, text: "明日の打ち合わせは十時からに変更して", stableLength: 13 });`);
  await expect(page.getByText("認識中")).toBeVisible();
  // 180ms のアニメーションが終わるのを待つ
  await expect(page.getByTestId("panel-card")).toHaveCSS("width", "440px");
  await page.waitForTimeout(300);
  const expanded = await frameSize(page);
  const expandCalls = (await panelSizes(page)).slice(before);
  // 途中の大きさを経由せず、最初の 1 回で最終の大きさを送る (ウィンドウがアニメーションを切らない)
  expect(expandCalls[0]).toEqual(expanded);
  expect(expandCalls.every((s) => s.width === expanded.width && s.height === expanded.height)).toBe(true);
  expect(expanded.width).toBeGreaterThan(pill.width);
  expect(expanded.height).toBeGreaterThan(pill.height);

  // 誤検出で表示が消えてピルへ戻る
  const beforeCollapse = (await panelSizes(page)).length;
  await mock(page, `api.result({ kind: "discarded", id: 1 });`);
  await expect(page.getByTestId("panel-card")).toHaveCSS("width", "240px");
  await page.waitForTimeout(300);
  const collapsed = await frameSize(page);
  expect(collapsed).toEqual(pill);
  const collapseCalls = (await panelSizes(page)).slice(beforeCollapse);
  expect(collapseCalls.at(-1)).toEqual(pill);
  // 縮む途中もカードより小さくしない (単調に縮む)
  for (let i = 1; i < collapseCalls.length; i++) {
    expect(collapseCalls[i].height).toBeLessThanOrEqual(collapseCalls[i - 1].height);
    expect(collapseCalls[i].width).toBeLessThanOrEqual(collapseCalls[i - 1].width);
  }
});

test("panel: ドラッグ領域はピル本体で、ボタンと余白には付けない", async ({ page }) => {
  await open(page, "window=panel&mock=idle", PANEL);
  const card = page.getByTestId("panel-card");
  await expect(card).toHaveAttribute("data-tauri-drag-region", "deep");
  await expect(page.getByTestId("panel-frame")).not.toHaveAttribute("data-tauri-drag-region");
  await expect(page.getByTestId("panel-frame")).toHaveCSS("pointer-events", "none");
  await expect(card.getByRole("button", { name: "音声入力をオフ" })).not.toHaveAttribute("data-tauri-drag-region");
});

// ---------- エラーからの復旧 ----------

test("panel: マイクが見つからない → マイクを選択 で設定の音声入力を開く", async ({ page }) => {
  await open(page, "window=panel&mock=error-mic", PANEL);
  await page.getByRole("button", { name: "マイクを選択" }).click();
  await expect.poll(async () => (await calls(page)).find((c) => c.cmd === "open_settings")?.args).toEqual({ category: "voice" });
});

test("panel: アクセシビリティ未許可 → システム設定を開く", async ({ page }) => {
  await open(page, "window=panel&mock=error-accessibility", PANEL);
  await page.getByRole("button", { name: "システム設定を開く" }).click();
  await expect
    .poll(async () => (await calls(page)).find((c) => c.cmd === "open_system_settings")?.args)
    .toEqual({ pane: "accessibility" });
});

test("panel: 復旧 command が未実装ならボタンを消す", async ({ page }) => {
  await open(page, "window=panel&mock=error-asr&unimplemented=restart_asr", PANEL);
  await page.getByRole("button", { name: "再起動" }).click();
  await expect(page.getByRole("button", { name: "再起動" })).toHaveCount(0);
  await expect(page.getByText("文字起こしが停止しました")).toBeVisible();
});

test("panel: 対応する command のない復旧 (start_setup) はボタンを出さない", async ({ page }) => {
  await open(page, "window=panel&mock=error-runtime", PANEL);
  await expect(page.getByText("モデルがありません")).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(0);
});

// ---------- settings-navigate ----------

test("settings: settings-navigate でカテゴリを切り替える", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=general", SETTINGS);
  await expect(page.getByText("ログイン時に起動")).toBeVisible();
  await mock(page, `api.fire("settings-navigate", { category: "storage" });`);
  await expect(page.getByText("実行環境とモデルのみ削除")).toBeVisible();
  await expect(page.getByRole("button", { name: "ストレージ" })).toHaveAttribute("aria-current", "page");
  // 未知のカテゴリは無視する
  await mock(page, `api.fire("settings-navigate", { category: "unknown" });`);
  await expect(page.getByText("実行環境とモデルのみ削除")).toBeVisible();
});

test("settings: open_settings(category) が開いている設定を切り替える", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=general", SETTINGS);
  await expect(page.getByText("ログイン時に起動")).toBeVisible();
  await mock(page, `api.invoke("open_settings", { category: "voice" });`);
  await expect(page.getByText("発話検出の感度")).toBeVisible();
});

// ---------- 未実装 command ----------

test("settings: ストレージの操作が未実装なら無効にして「未対応」を示す", async ({ page }) => {
  await open(page, "window=settings&mock=unimplemented&category=storage", SETTINGS);
  const uninstall = page.getByRole("button", { name: "アンインストール…" });
  await expect(uninstall).toBeDisabled();
  await expect(page.getByRole("button", { name: "削除" })).toBeDisabled();
  await expect(page.getByText("—")).toBeVisible();
  await page.getByTestId("unimplemented").last().hover();
  await expect(page.getByRole("tooltip")).toContainText("この版では未対応です");
});

test("settings: 再起動が未実装なら押した後に無効にする", async ({ page }) => {
  await open(page, "window=settings&mock=unimplemented&category=recognition", SETTINGS);
  const restart = page.getByRole("button", { name: "再起動" });
  await expect(restart).toBeEnabled();
  await restart.click();
  await expect(restart).toBeDisabled();
});

test("setup: ダウンロードが未実装なら案内して次へ進める", async ({ page }) => {
  await open(page, "window=setup&mock=download-unimplemented", SETUP);
  await expect(page.getByText("この版ではダウンロードに未対応です", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "次へ" }).click();
  await expect(page.getByText("試しに話してみてください")).toBeVisible();
});

// ---------- 購読と初期値の順序 ----------

test("panel: 初期値の応答より新しい status-changed を優先する", async ({ page }) => {
  // get_status は呼ばれた時点の値 (オフ) を 500ms 遅れて返す
  await open(page, "window=panel&mock=off&slow=get_status", PANEL);
  await expect.poll(async () => (await calls(page)).some((c) => c.cmd === "get_status")).toBe(true);
  await mock(page, `api.setStatus({ phase: "listening" });`);
  await expect(page.getByText("待機中")).toBeVisible();
  await page.waitForTimeout(700);
  // 遅れて届いた古い「オフ」で上書きされない
  await expect(page.getByText("待機中")).toBeVisible();
  await expect(page.getByRole("button", { name: "音声入力をオフ" })).toBeVisible();
});

test("settings: ウィンドウが再表示されたら現在値を取り直す", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=general", SETTINGS);
  await expect(page.getByRole("switch", { name: "ログイン時に起動" })).toBeChecked();
  // 非表示中に変わって event を取りこぼした想定 (db だけ変える)
  await mock(page, `api.db.settings = { ...api.db.settings, launchAtLogin: false };`);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("switch", { name: "ログイン時に起動" })).not.toBeChecked();
});

// ---------- ダークモード ----------

test("ダーク/ライトの切り替えがその場で反映される", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await open(page, "window=settings&mock=default&category=general", SETTINGS);
  const bg = () => page.getByTestId("window-frame").evaluate((el) => getComputedStyle(el).backgroundColor);
  const light = await bg();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(bg).not.toBe(light);
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(bg).toBe(light);
});
