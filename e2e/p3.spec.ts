/*
 * P3 (設定の読み書き・復旧) の確認: open_setup、設定の即時保存・スライダーの間引き・他ウィンドウからの反映・
 * 保存エラーの表示、音声コマンドの検証、語彙ヒント、マイク一覧の再取得、AppStatus.seq。
 */
import { expect, test, type Page } from "@playwright/test";

const PANEL = { width: 560, height: 260 };
const SETTINGS = { width: 840, height: 640 };

type Call = { cmd: string; args: Record<string, unknown> };
type Size = { width: number; height: number };

async function open(page: Page, query: string, viewport: Size) {
  await page.setViewportSize(viewport);
  await page.goto(`/?${query}`);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => "__mukuchiMock" in window);
}

function calls(page: Page, cmd: string): Promise<Call[]> {
  return page.evaluate(
    (c) =>
      (window as unknown as { __mukuchiMock: { calls: Call[] } }).__mukuchiMock.calls.filter((x) => x.cmd === c),
    cmd,
  );
}

/** モックの API をページ内で呼ぶ */
async function mock(page: Page, fn: string) {
  await page.evaluate(`(() => { const api = window.__mukuchiMock; ${fn} })()`);
}

/** React の値の追跡を通すため、ネイティブの setter で値を入れてから input を送る (ドラッグ中の 1 目盛り) */
async function slide(page: Page, label: string, value: number) {
  await page.getByRole("slider", { name: label }).evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

// ---------- open_setup ----------

test("panel: 実行環境とモデルがない → セットアップを開く で open_setup", async ({ page }) => {
  await open(page, "window=panel&mock=error-runtime", PANEL);
  await expect(page.getByText("モデルがありません")).toBeVisible();
  await page.getByRole("button", { name: "セットアップを開く" }).click();
  await expect.poll(async () => (await calls(page, "open_setup")).length).toBe(1);
  await page.screenshot({ path: "e2e/screenshots/panel-error-runtime-action.png" });
});

test("settings: 認識で実行環境とモデルがない → セットアップを開く", async ({ page }) => {
  await open(page, "window=settings&mock=runtime-missing&category=recognition", SETTINGS);
  await expect(page.getByText("実行環境とモデルがありません")).toBeVisible();
  await page.getByRole("button", { name: "セットアップを開く" }).click();
  await expect.poll(async () => (await calls(page, "open_setup")).length).toBe(1);
});

test("settings: open_setup が未実装なら無効にして「未対応」を示す", async ({ page }) => {
  await open(page, "window=settings&mock=runtime-missing&category=recognition&unimplemented=open_setup", SETTINGS);
  const button = page.getByRole("button", { name: "セットアップを開く" });
  await button.click();
  await expect(button).toBeDisabled();
});

// ---------- 即時保存・エラー・他ウィンドウ ----------

test("settings: ログイン時に起動を切り替えると即時保存する", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=general", SETTINGS);
  const sw = page.getByRole("switch", { name: "ログイン時に起動" });
  await sw.click();
  await expect(sw).not.toBeChecked();
  await expect.poll(async () => (await calls(page, "update_settings")).map((c) => c.args)).toEqual([
    { patch: { launchAtLogin: false } },
  ]);
});

test("settings: 保存に失敗したら値を戻し、操作の近くにエラーを出す", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=general", SETTINGS);
  await mock(page, `api.fail.update_settings = "ログイン項目を登録できませんでした";`);
  const sw = page.getByRole("switch", { name: "ログイン時に起動" });
  await sw.click();
  await expect(page.getByRole("alert")).toHaveText("ログイン項目を登録できませんでした");
  await expect(sw).toBeChecked();
  // 次に成功したらエラーを消す
  await mock(page, `delete api.fail.update_settings;`);
  await sw.click();
  await expect(sw).not.toBeChecked();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("settings: 他ウィンドウの変更 (settings-changed) を反映する", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  await expect(page.getByRole("slider", { name: "発話検出の感度" })).toHaveValue("60");
  // 別ウィンドウ (setup 等) からの update_settings
  await mock(page, `api.invoke("update_settings", { patch: { vadSensitivity: 25, silenceMs: 2000, inputDeviceId: "airpods" } });`);
  await expect(page.getByRole("slider", { name: "発話検出の感度" })).toHaveValue("25");
  await expect(page.getByText("2.0 秒")).toBeVisible();
  await expect(page.getByLabel("マイク")).toHaveValue("airpods");
});

test("settings: 保存の応答待ちに届いた古い settings-changed で操作した値を戻さない", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=general&slow=update_settings", SETTINGS);
  const sw = page.getByRole("switch", { name: "ログイン時に起動" });
  await sw.click();
  await expect(sw).not.toBeChecked();
  // 応答 (500ms 後) より前に、変更前の値を含む settings-changed が届く (他ウィンドウが別のキーを変えた)
  await mock(page, `api.fire("settings-changed", { ...api.db.settings, launchAtLogin: true });`);
  await page.waitForTimeout(100);
  await expect(sw).not.toBeChecked();
  // 応答が届いた後も変わらない
  await expect.poll(async () => (await calls(page, "update_settings")).length).toBe(1);
  await page.waitForTimeout(600);
  await expect(sw).not.toBeChecked();
});

// ---------- スライダー ----------

test("settings: スライダーはドラッグ中に間引き、止まって 150ms 後に 1 回だけ保存する", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  for (const v of [61, 64, 68, 72]) await slide(page, "発話検出の感度", v);
  // 表示はすぐ追従する
  await expect(page.getByText("72", { exact: true })).toBeVisible();
  expect(await calls(page, "update_settings")).toHaveLength(0);
  await expect.poll(async () => (await calls(page, "update_settings")).map((c) => c.args)).toEqual([
    { patch: { vadSensitivity: 72 } },
  ]);
});

test("settings: スライダーを離したら待たずに保存する", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  await slide(page, "話し終わりと判定するまでの無音", 8);
  await page.getByRole("slider", { name: "話し終わりと判定するまでの無音" }).dispatchEvent("pointerup");
  // 150ms を待たずに保存される
  expect((await calls(page, "update_settings")).map((c) => c.args)).toEqual([{ patch: { silenceMs: 800 } }]);
  await expect(page.getByText("0.8 秒")).toBeVisible();
  await page.waitForTimeout(300);
  expect(await calls(page, "update_settings")).toHaveLength(1);
});

test("settings: キーボードでの変更も保存する", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  await page.getByRole("slider", { name: "発話検出の感度" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await calls(page, "update_settings")).at(-1)?.args).toEqual({ patch: { vadSensitivity: 61 } });
});

test("settings: しきい値の縦線はオン中は audio-level の threshold、オフ中・操作中は感度から求める", async ({ page }) => {
  // default はオン (threshold 0.55 を流す)
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  const line = page.getByTestId("level-threshold");
  await expect(line).toHaveAttribute("style", /left: 55(\.\d+)?%/);
  // ドラッグ中は保存前の感度から求めた位置 (感度 100 → -55 dB → 0.1)
  await slide(page, "発話検出の感度", 100);
  await expect(line).toHaveAttribute("style", /left: 10(\.\d+)?%/);

  // オフ (perm-denied はオフ): 感度 60 → -45 dB → 0.3
  await open(page, "window=settings&mock=perm-denied&category=voice", SETTINGS);
  await expect(page.getByTestId("level-threshold")).toHaveAttribute("style", /left: 30(\.\d+)?%/);
});

// ---------- マイク ----------

test("settings: マイクの接続変化 (input-devices-changed) とフォーカスで一覧を取り直す", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  const select = page.getByLabel("マイク");
  await expect(select.locator("option", { hasText: "AirPods Pro" })).toHaveCount(1);
  await mock(page, `api.db.devices = [...api.db.devices, { id: "yeti", name: "Yeti", isDefault: false }]; api.fire("input-devices-changed", api.db.devices);`);
  await expect(select.locator("option", { hasText: "Yeti" })).toHaveCount(1);
  // 一覧を含まない event (旧形式) でも取り直す
  await mock(page, `api.db.devices = [...api.db.devices, { id: "hdmi", name: "HDMI" , isDefault: false }]; api.fire("input-devices-changed", null);`);
  await expect(select.locator("option", { hasText: "HDMI" })).toHaveCount(1);
  // event を取りこぼしてもフォーカスで取り直す
  await mock(page, `api.db.devices = api.db.devices.filter((d) => d.id !== "airpods");`);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(select.locator("option", { hasText: "AirPods Pro" })).toHaveCount(0);
});

test("settings: 選んだマイクが外れても選択を残し「接続されていません」と示す", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  const select = page.getByLabel("マイク");
  await select.selectOption("usb");
  await expect.poll(async () => (await calls(page, "update_settings")).at(-1)?.args).toEqual({ patch: { inputDeviceId: "usb" } });
  await mock(page, `api.db.devices = api.db.devices.filter((d) => d.id !== "usb"); api.fire("input-devices-changed", api.db.devices);`);
  await expect(select).toHaveValue("usb");
  await expect(select.locator("option:checked")).toHaveText("選択中のマイク（接続されていません）");
  // 既定に戻す
  await select.selectOption("");
  await expect.poll(async () => (await calls(page, "update_settings")).at(-1)?.args).toEqual({ patch: { inputDeviceId: null } });
});

// ---------- 入力しないアプリ ----------

test("settings: 起動中のアプリを取得できなければメニューに理由を出す", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  await mock(page, `api.fail.list_running_apps = "アプリの一覧を取得できませんでした";`);
  await page.getByRole("button", { name: "アプリを追加" }).click();
  await expect(page.getByRole("menu").getByText("アプリの一覧を取得できませんでした")).toBeVisible();
});

test("settings: 登録済みのアプリは追加候補に出さない", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  await page.getByRole("button", { name: "アプリを追加" }).click();
  await expect(page.getByRole("menuitem", { name: "Safari" })).toBeVisible();
  // ターミナルは登録済み
  await expect(page.getByRole("menuitem", { name: "ターミナル" })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Safari" }).click();
  await expect.poll(async () => {
    const last = (await calls(page, "update_settings")).at(-1)?.args as { patch: { excludedApps: { bundleId: string }[] } };
    return last?.patch.excludedApps.map((a) => a.bundleId);
  }).toEqual(["com.1password.1password", "com.apple.Terminal", "com.apple.Safari"]);
});

// ---------- 音声コマンド ----------

async function openAddCommand(page: Page) {
  await open(page, "window=settings&mock=default&category=commands", SETTINGS);
  await page.getByRole("button", { name: "コマンドを追加" }).click();
  return page.getByRole("dialog");
}

test("settings: 音声コマンドの言い方を Rust と同じ正規化で検証する", async ({ page }) => {
  const dialog = await openAddCommand(page);
  const input = dialog.getByLabel("言い方");
  const save = dialog.getByRole("button", { name: "保存" });
  // 空欄は保存できないが、エラーは出さない
  await expect(save).toBeDisabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);

  // 句読点・記号を除くと既存の「確定」と同じ
  await input.fill("「確定。」");
  await expect(dialog.getByRole("alert")).toContainText("他のコマンド（Enter）の「確定」と重複しています");
  await expect(save).toBeDisabled();
  // 半角カナは NFKC で全角になり「エンター」と同じ
  await input.fill("ｴﾝﾀｰ");
  await expect(dialog.getByRole("alert")).toContainText("「エンター」と重複しています");
  // 同じコマンド内の重複 (大文字・全角は同じとみなす)
  await input.fill("Next、ｎｅｘｔ");
  await expect(dialog.getByRole("alert")).toContainText("「Next」と「ｎｅｘｔ」は同じ言い方とみなされます");
  // 記号だけ
  await input.fill("！？");
  await expect(dialog.getByRole("alert")).toContainText("記号や空白だけのため使えません");

  await input.fill("次へ、タブ");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(save).toBeEnabled();
});

test("settings: 言い方を複数・修飾キー付きで追加する", async ({ page }) => {
  const dialog = await openAddCommand(page);
  await dialog.getByLabel("言い方").fill("前へ、戻る");
  await dialog.getByRole("button", { name: "Shift" }).click();
  await dialog.getByLabel("キー", { exact: true }).selectOption("tab");
  await expect(dialog.getByText("Shift + Tab")).toBeVisible();
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("前へ", { exact: true })).toBeVisible();
  await expect(page.getByText("戻る", { exact: true })).toBeVisible();
  const last = (await calls(page, "update_settings")).at(-1)?.args as {
    patch: { voiceCommands: { phrases: string[]; key: unknown }[] };
  };
  expect(last.patch.voiceCommands.at(-1)).toMatchObject({
    phrases: ["前へ", "戻る"],
    key: { key: "tab", modifiers: ["shift"] },
  });
});

test("settings: 音声コマンドを編集・削除する", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=commands", SETTINGS);
  // 「確定、エンター」の行を編集。自分自身の言い方とは重複扱いしない
  await page.getByRole("button", { name: "編集" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("言い方")).toHaveValue("確定、エンター");
  await expect(dialog.getByRole("button", { name: "保存" })).toBeEnabled();
  // 他のコマンドの言い方は使えない
  await dialog.getByLabel("言い方").fill("確定、送信");
  await expect(dialog.getByRole("alert")).toContainText("他のコマンド（⌘ + Enter）の「送信」と重複しています");
  await dialog.getByLabel("言い方").fill("確定、決定");
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(page.getByText("決定", { exact: true })).toBeVisible();
  await expect(page.getByText("エンター", { exact: true })).toHaveCount(0);

  // 「改行」の行を削除
  await page.getByRole("button", { name: "削除" }).nth(1).click();
  await expect(page.getByText("改行", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Shift + Enter")).toHaveCount(0);
  const last = (await calls(page, "update_settings")).at(-1)?.args as { patch: { voiceCommands: { id: string }[] } };
  expect(last.patch.voiceCommands.map((c) => c.id)).toEqual(["confirm", "send"]);
});

test("settings: 編集中に他ウィンドウで追加された言い方とも重複を検出する", async ({ page }) => {
  const dialog = await openAddCommand(page);
  await dialog.getByLabel("言い方").fill("やり直し");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await mock(
    page,
    `api.invoke("update_settings", { patch: { voiceCommands: [...api.db.settings.voiceCommands, { id: "undo", phrases: ["やり直し"], key: { key: "backspace", modifiers: ["cmd"] } }] } });`,
  );
  await expect(dialog.getByRole("alert")).toContainText("他のコマンド（⌘ + Backspace）の「やり直し」と重複しています");
});

// ---------- 語彙ヒント ----------

test("settings: 語彙ヒントは前後の空白を除き、重複を追加しない", async ({ page }) => {
  await open(page, "window=settings&mock=default&category=recognition", SETTINGS);
  const input = page.getByLabel("語彙ヒントに追加する語");
  await input.fill(" 無口 、Tauri、無口、Visual Studio Code ");
  await page.keyboard.press("Enter");
  await expect(page.getByText("8 語")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("「Tauri」「無口」は登録済みです");
  const last = (await calls(page, "update_settings")).at(-1)?.args as { patch: { vocabulary: string[] } };
  expect(last.patch.vocabulary.slice(-2)).toEqual(["無口", "Visual Studio Code"]);
  // 全角・半角の違いだけの語も同じとみなす
  await input.fill("ｍｕｋｕｃｈｉ");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toHaveText("「ｍｕｋｕｃｈｉ」は登録済みです");
  await expect(page.getByText("8 語")).toBeVisible();
  // 削除
  await page.getByRole("button", { name: "無口 を削除" }).click();
  await expect(page.getByText("7 語")).toBeVisible();
});

// ---------- AppStatus.seq ----------

test("panel: seq が前回より小さい status-changed は捨てる", async ({ page }) => {
  await open(page, "window=panel&mock=off", PANEL);
  await expect(page.getByRole("button", { name: "音声入力をオン" })).toBeVisible();
  await mock(page, `api.fire("status-changed", { phase: "listening", loadingProgress: null, error: null, seq: 5 });`);
  await expect(page.getByText("待機中")).toBeVisible();
  // 遅れて届いた古い状態
  await mock(page, `api.fire("status-changed", { phase: "off", loadingProgress: null, error: null, seq: 3 });`);
  await page.waitForTimeout(200);
  await expect(page.getByText("待機中")).toBeVisible();
  await mock(page, `api.fire("status-changed", { phase: "off", loadingProgress: null, error: null, seq: 6 });`);
  await expect(page.getByRole("button", { name: "音声入力をオン" })).toBeVisible();
});

test("panel: 未知のエラーコードは Rust のメッセージをそのまま出す", async ({ page }) => {
  await open(page, "window=panel&mock=off", PANEL);
  await mock(
    page,
    `api.setStatus({ phase: "error", error: { code: "vad_unavailable", message: "発話検出を開始できません", action: "restart_everything" } });`,
  );
  await expect(page.getByText("発話検出を開始できません")).toBeVisible();
  await expect(page.getByRole("button")).toHaveCount(0);
});
