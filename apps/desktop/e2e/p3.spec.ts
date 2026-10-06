/*
 * P3 (設定の読み書き・復旧) の確認: open_setup、設定の即時保存・スライダーの間引き・他ウィンドウからの反映・
 * 保存エラーの表示、音声コマンドの検証、認識のヒント、マイク一覧の再取得、AppStatus.seq。
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const PANEL = { width: 560, height: 260 };
const SETTINGS = { width: 840, height: 640 };

type Call = { cmd: string; args: Record<string, unknown> };
type Size = { width: number; height: number };

async function open(page: Page, query: string, viewport: Size) {
  await page.setViewportSize(viewport);
  await page.goto(`/?${query}`);
  // 描画されてから待つ (描画前は同梱フォントの読み込みが始まっておらず、fonts.ready がすぐ解決する)
  await page.waitForFunction(() => (document.getElementById("root")?.childElementCount ?? 0) > 0);
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

/**
 * ページのタイマーを止め、以降は clock.runFor で進めた分だけ発火させる。
 * 間引き (150ms) や遅い応答 (500ms) を実時間で待つと、遅い CI では検証前に発火してしまうため。
 * 読み込み中は時間を流す (止めたまま goto すると読み込みが進まないことがある)。open の前に install しておく
 */
async function pauseClock(page: Page) {
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(now + 1000);
}

/** React の値の追跡を通すため、ネイティブの setter で値を入れてから input を送る (ドラッグ中の 1 目盛り) */
async function slide(page: Page, label: string, value: number) {
  await page.getByRole("slider", { name: label }).evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

/** 日本語の既定の音声コマンド。正規化 (NFKC・記号除去) の検証は日本語の言い方で行うため、表示言語によらずこれを入れる */
const JA_COMMANDS = [
  { id: "confirm", phrases: ["確定", "エンター"], key: { key: "enter", modifiers: [] } },
  { id: "newline", phrases: ["改行"], key: { key: "enter", modifiers: ["shift"] } },
  { id: "send", phrases: ["送信"], key: { key: "enter", modifiers: ["cmd"] } },
];

async function setJaCommands(page: Page) {
  await mock(page, `api.invoke("update_settings", { patch: { voiceCommands: ${JSON.stringify(JA_COMMANDS)} } });`);
}

// ---------- open_setup ----------

test("panel: 実行環境とモデルがない → セットアップを開く で open_setup", async ({ page, m, shot }) => {
  await open(page, "window=panel&mock=error-runtime", PANEL);
  await expect(page.getByText(m.panel.errors.runtime_missing)).toBeVisible();
  await page.getByRole("button", { name: m.errorActions.start_setup }).click();
  await expect.poll(async () => (await calls(page, "open_setup")).length).toBe(1);
  await page.screenshot({ path: shot("panel-error-runtime-action") });
});

test("settings: 認識で実行環境とモデルがない → セットアップを開く", async ({ page, m }) => {
  await open(page, "window=settings&mock=runtime-missing&category=recognition", SETTINGS);
  await expect(page.getByText(m.settings.recognition.missingSub)).toBeVisible();
  await page.getByRole("button", { name: m.common.openSetup }).click();
  await expect.poll(async () => (await calls(page, "open_setup")).length).toBe(1);
});

// ---------- 即時保存・エラー・他ウィンドウ ----------

test("settings: ログイン時に起動を切り替えると即時保存する", async ({ page, m }) => {
  await open(page, "window=settings&mock=default&category=general", SETTINGS);
  const sw = page.getByRole("switch", { name: m.settings.general.launchAtLogin });
  await sw.click();
  await expect(sw).not.toBeChecked();
  await expect.poll(async () => (await calls(page, "update_settings")).map((c) => c.args)).toEqual([
    { patch: { launchAtLogin: false } },
  ]);
});

test("settings: 保存に失敗したら値を戻し、操作の近くにエラーを出す", async ({ page, m }) => {
  await open(page, "window=settings&mock=default&category=general", SETTINGS);
  await mock(page, `api.fail.update_settings = "ログイン項目を登録できませんでした";`);
  const sw = page.getByRole("switch", { name: m.settings.general.launchAtLogin });
  await sw.click();
  await expect(page.getByRole("alert")).toContainText("ログイン項目を登録できませんでした");
  await expect(sw).toBeChecked();
  // 次に成功したらエラーを消す
  await mock(page, `delete api.fail.update_settings;`);
  await sw.click();
  await expect(sw).not.toBeChecked();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

const APPROVAL_ERROR =
  "ログイン時に起動するには承認が必要です。システム設定 > 一般 > ログイン項目 で mukuchi をオンにしてください";

test("settings: ログイン時に起動をオンにできなければエラーとログイン項目を開くボタンを出す", async ({ page, m, shot }) => {
  await open(page, "window=settings&mock=default&category=general", SETTINGS);
  const sw = page.getByRole("switch", { name: m.settings.general.launchAtLogin });
  // オフにしてからオンで失敗させる (承認待ち)
  await sw.click();
  await expect(sw).not.toBeChecked();
  await mock(page, `api.fail.update_settings = ${JSON.stringify(APPROVAL_ERROR)};`);
  await sw.click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(APPROVAL_ERROR);
  await expect(sw).not.toBeChecked();
  await page.screenshot({ path: shot("settings-launch-at-login-error") });
  await alert.getByRole("button", { name: m.common.openSystemSettings }).click();
  await expect.poll(async () => (await calls(page, "open_system_settings")).map((c) => c.args)).toEqual([
    { pane: "login_items" },
  ]);
});

test("setup: 完了画面でログイン時に起動をオンにできなければエラーとログイン項目を開くボタンを出す", async ({ page, m, shot }) => {
  await open(page, "window=setup&mock=done", { width: 640, height: 520 });
  const sw = page.getByRole("switch", { name: m.settings.general.launchAtLogin });
  await expect(sw).toBeChecked();
  await sw.click();
  await expect(sw).not.toBeChecked();
  await mock(page, `api.fail.update_settings = ${JSON.stringify(APPROVAL_ERROR)};`);
  await sw.click();
  const alert = page.getByRole("alert");
  await expect(alert).toContainText(APPROVAL_ERROR);
  await expect(sw).not.toBeChecked();
  await page.screenshot({ path: shot("setup-launch-at-login-error") });
  await alert.getByRole("button", { name: m.common.openSystemSettings }).click();
  await expect.poll(async () => (await calls(page, "open_system_settings")).map((c) => c.args)).toEqual([
    { pane: "login_items" },
  ]);
  // 次に成功したらエラーを消す
  await mock(page, `delete api.fail.update_settings;`);
  await sw.click();
  await expect(sw).toBeChecked();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("settings: 他ウィンドウの変更 (settings-changed) を反映する", async ({ page, m }) => {
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  await expect(page.getByRole("slider", { name: m.settings.voice.sensitivity })).toHaveValue("60");
  // 別ウィンドウ (setup 等) からの update_settings
  await mock(page, `api.invoke("update_settings", { patch: { vadSensitivity: 25, silenceMs: 2000, inputDeviceId: "airpods" } });`);
  await expect(page.getByRole("slider", { name: m.settings.voice.sensitivity })).toHaveValue("25");
  await expect(page.getByText(m.format.seconds("2.0"))).toBeVisible();
  await expect(page.getByLabel(m.settings.voice.microphone)).toHaveValue("airpods");
});

test("settings: 保存の応答待ちに届いた古い settings-changed で操作した値を戻さない", async ({ page, m }) => {
  await page.clock.install();
  await open(page, "window=settings&mock=default&category=general&slow=update_settings", SETTINGS);
  await pauseClock(page);
  const sw = page.getByRole("switch", { name: m.settings.general.launchAtLogin });
  await sw.click();
  await expect(sw).not.toBeChecked();
  await expect.poll(async () => (await calls(page, "update_settings")).length).toBe(1);
  // 応答 (500ms 後) より前に、変更前の値を含む settings-changed が届く (他ウィンドウが別のキーを変えた)
  await mock(page, `api.fire("settings-changed", { ...api.db.settings, launchAtLogin: true });`);
  await page.waitForTimeout(100);
  await expect(sw).not.toBeChecked();
  // 応答が届いた後も変わらない
  await page.clock.runFor(500);
  await page.waitForTimeout(100);
  await expect(sw).not.toBeChecked();
  expect(await calls(page, "update_settings")).toHaveLength(1);
});

// ---------- スライダー ----------

test("settings: スライダーはドラッグ中に間引き、止まって 150ms 後に 1 回だけ保存する", async ({ page, m }) => {
  await page.clock.install();
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  await pauseClock(page);
  // 1 目盛りごとに 100ms 空ける (間引きの 150ms 未満なので、ドラッグ中は保存しない)
  for (const v of [61, 64, 68, 72]) {
    await slide(page, m.settings.voice.sensitivity, v);
    await page.clock.runFor(100);
  }
  // 表示はすぐ追従する
  await expect(page.getByText("72", { exact: true })).toBeVisible();
  expect(await calls(page, "update_settings")).toHaveLength(0);
  // 最後の目盛りから 149ms ではまだ保存しない
  await page.clock.runFor(49);
  expect(await calls(page, "update_settings")).toHaveLength(0);
  // 150ms で最後の値を 1 回だけ保存する
  await page.clock.runFor(1);
  await expect.poll(async () => (await calls(page, "update_settings")).map((c) => c.args)).toEqual([
    { patch: { vadSensitivity: 72 } },
  ]);
  await page.clock.runFor(1000);
  expect(await calls(page, "update_settings")).toHaveLength(1);
});

test("settings: スライダーを離したら待たずに保存する", async ({ page, m }) => {
  await page.clock.install();
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  await pauseClock(page);
  await slide(page, m.settings.voice.silence, 8);
  await page.getByRole("slider", { name: m.settings.voice.silence }).dispatchEvent("pointerup");
  // 150ms を待たずに保存される (時計は止めてある)
  expect((await calls(page, "update_settings")).map((c) => c.args)).toEqual([{ patch: { silenceMs: 800 } }]);
  await expect(page.getByText(m.format.seconds("0.8"))).toBeVisible();
  // 間引きのタイマーは取り消されていて、150ms 経っても二重に保存しない
  await page.clock.runFor(300);
  expect(await calls(page, "update_settings")).toHaveLength(1);
});

test("settings: キーボードでの変更も保存する", async ({ page, m }) => {
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  await page.getByRole("slider", { name: m.settings.voice.sensitivity }).focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await calls(page, "update_settings")).at(-1)?.args).toEqual({ patch: { vadSensitivity: 61 } });
});

test("settings: トラックの塗り分け位置はオン中は audio-level の threshold、オフ中・操作中は感度から求める", async ({ page, m }) => {
  // default はオン (threshold 0.55 を流す)
  await page.clock.install();
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  const below = page.getByTestId("input-level-meter-below");
  await expect(below).toHaveAttribute("style", /width: 55(\.\d+)?%/);
  // 操作中の表示は間引き (150ms) で保存されるまでしか出ないので、時計を止めて確認する
  await pauseClock(page);
  // ドラッグ中は保存前の感度から求めた位置 (感度 100 → -55 dB → 0.1)。レベル 0.3 前後が境目を超えるので青になる
  await slide(page, m.settings.voice.sensitivity, 100);
  await expect(below).toHaveAttribute("style", /width: 10(\.\d+)?%/);
  await expect(page.getByTestId("input-level-meter")).toHaveAttribute("data-active", "true");
  await page.clock.resume();

  // オフ (perm-denied はオフ): 感度 60 → -45 dB → 0.3。バーは出さない
  await open(page, "window=settings&mock=perm-denied&category=voice", SETTINGS);
  await expect(page.getByTestId("input-level-meter-below")).toHaveAttribute("style", /width: 30(\.\d+)?%/);
  await expect(page.getByTestId("input-level-meter")).toHaveAttribute("data-active", "false");
});

test("panel: メーターはしきい値でトラックを塗り分け、超えた時だけバーを青にする", async ({ page }) => {
  await open(page, "window=panel&mock=idle", PANEL);
  const meter = page.getByTestId("level-meter");
  await expect(page.getByTestId("level-meter-below")).toHaveAttribute("style", /width: 55(\.\d+)?%/);
  await expect(meter).toHaveAttribute("data-active", "false");
  await open(page, "window=panel&mock=speaking", PANEL);
  await expect(page.getByTestId("level-meter")).toHaveAttribute("data-active", "true");
  await open(page, "window=panel&mock=finalizing", PANEL);
  await expect(page.getByTestId("level-meter")).toHaveAttribute("data-active", "false");
});

// ---------- マイク ----------

test("settings: マイクの接続変化 (input-devices-changed) とフォーカスで一覧を取り直す", async ({ page, m }) => {
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  const select = page.getByLabel(m.settings.voice.microphone);
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

test("settings: 選んだマイクが外れても選択を残し「接続されていません」と示す", async ({ page, m }) => {
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  const select = page.getByLabel(m.settings.voice.microphone);
  await select.selectOption("usb");
  await expect.poll(async () => (await calls(page, "update_settings")).at(-1)?.args).toEqual({ patch: { inputDeviceId: "usb" } });
  await mock(page, `api.db.devices = api.db.devices.filter((d) => d.id !== "usb"); api.fire("input-devices-changed", api.db.devices);`);
  await expect(select).toHaveValue("usb");
  await expect(select.locator("option:checked")).toHaveText(m.settings.voice.disconnected);
  // 既定に戻す
  await select.selectOption("");
  await expect.poll(async () => (await calls(page, "update_settings")).at(-1)?.args).toEqual({ patch: { inputDeviceId: null } });
});

// ---------- 入力しないアプリ ----------

test("settings: 起動中のアプリを取得できなければメニューに理由を出す", async ({ page, m }) => {
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  await mock(page, `api.fail.list_running_apps = "アプリの一覧を取得できませんでした";`);
  await page.getByRole("button", { name: m.settings.voice.addApp }).click();
  await expect(page.getByRole("menu").getByText("アプリの一覧を取得できませんでした")).toBeVisible();
});

test("settings: 登録済みのアプリは追加候補に出さない", async ({ page, m, sp }) => {
  await open(page, "window=settings&mock=default&category=voice", SETTINGS);
  await page.getByRole("button", { name: m.settings.voice.addApp }).click();
  await expect(page.getByRole("menuitem", { name: "Safari" })).toBeVisible();
  // ターミナルは登録済み
  await expect(page.getByRole("menuitem", { name: sp.terminal })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Safari" }).click();
  await expect.poll(async () => {
    const last = (await calls(page, "update_settings")).at(-1)?.args as { patch: { excludedApps: { bundleId: string }[] } };
    return last?.patch.excludedApps.map((a) => a.bundleId);
  }).toEqual(["com.1password.1password", "com.apple.Terminal", "com.apple.Safari"]);
});

// ---------- 音声コマンド ----------

async function openAddCommand(page: Page, addLabel: string) {
  await open(page, "window=settings&mock=default&category=commands", SETTINGS);
  await setJaCommands(page);
  await page.getByRole("button", { name: addLabel }).click();
  return page.getByRole("dialog");
}

test("settings: 音声コマンドの言い方を Rust と同じ正規化で検証する", async ({ page, m }) => {
  const v = m.settings.commands.validation;
  const dialog = await openAddCommand(page, m.settings.commands.add);
  const input = dialog.getByLabel(m.settings.commands.phrases);
  const save = dialog.getByRole("button", { name: m.common.save });
  // 空欄は保存できないが、エラーは出さない
  await expect(save).toBeDisabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);

  // 句読点・記号を除くと既存の「確定」と同じ
  await input.fill("「確定。」");
  await expect(dialog.getByRole("alert")).toContainText(v.conflict("「確定。」", "Enter", "確定"));
  await expect(save).toBeDisabled();
  // 半角カナは NFKC で全角になり「エンター」と同じ
  await input.fill("ｴﾝﾀｰ");
  await expect(dialog.getByRole("alert")).toContainText(v.conflict("ｴﾝﾀｰ", "Enter", "エンター"));
  // 同じコマンド内の重複 (大文字・全角は同じとみなす)
  await input.fill("Next、ｎｅｘｔ");
  await expect(dialog.getByRole("alert")).toContainText(v.equivalent("Next", "ｎｅｘｔ"));
  // 記号だけ
  await input.fill("！？");
  await expect(dialog.getByRole("alert")).toContainText(v.symbolsOnly("！？"));

  await input.fill("次へ、タブ");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(save).toBeEnabled();
});

test("settings: 言い方を複数・修飾キー付きで追加する", async ({ page, m }) => {
  const dialog = await openAddCommand(page, m.settings.commands.add);
  await dialog.getByLabel(m.settings.commands.phrases).fill("前へ、戻る");
  await dialog.getByRole("button", { name: "Shift" }).click();
  await dialog.getByLabel(m.settings.commands.keyName, { exact: true }).selectOption("tab");
  await expect(dialog.getByText("Shift + Tab")).toBeVisible();
  await dialog.getByRole("button", { name: m.common.save }).click();
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

test("settings: 音声コマンドを編集・削除する", async ({ page, m }) => {
  await open(page, "window=settings&mock=default&category=commands", SETTINGS);
  await setJaCommands(page);
  await expect(page.getByText("エンター", { exact: true })).toBeVisible();
  // 「確定、エンター」の行を編集。自分自身の言い方とは重複扱いしない
  await page.getByRole("button", { name: m.settings.commands.edit }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel(m.settings.commands.phrases)).toHaveValue(["確定", "エンター"].join(m.settings.commands.phraseJoiner));
  await expect(dialog.getByRole("button", { name: m.common.save })).toBeEnabled();
  // 他のコマンドの言い方は使えない
  await dialog.getByLabel(m.settings.commands.phrases).fill("確定、送信");
  await expect(dialog.getByRole("alert")).toContainText(m.settings.commands.validation.conflict("送信", "⌘ + Enter", "送信"));
  await dialog.getByLabel(m.settings.commands.phrases).fill("確定、決定");
  await dialog.getByRole("button", { name: m.common.save }).click();
  await expect(page.getByText("決定", { exact: true })).toBeVisible();
  await expect(page.getByText("エンター", { exact: true })).toHaveCount(0);

  // 「改行」の行を削除
  await page.getByRole("button", { name: m.settings.commands.delete }).nth(1).click();
  await expect(page.getByText("改行", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Shift + Enter")).toHaveCount(0);
  const last = (await calls(page, "update_settings")).at(-1)?.args as { patch: { voiceCommands: { id: string }[] } };
  expect(last.patch.voiceCommands.map((c) => c.id)).toEqual(["confirm", "send"]);
});

test("settings: 編集中に他ウィンドウで追加された言い方とも重複を検出する", async ({ page, m }) => {
  const dialog = await openAddCommand(page, m.settings.commands.add);
  await dialog.getByLabel(m.settings.commands.phrases).fill("やり直し");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await mock(
    page,
    `api.invoke("update_settings", { patch: { voiceCommands: [...api.db.settings.voiceCommands, { id: "undo", phrases: ["やり直し"], key: { key: "backspace", modifiers: ["cmd"] } }] } });`,
  );
  await expect(dialog.getByRole("alert")).toContainText(m.settings.commands.validation.conflict("やり直し", "⌘ + Backspace", "やり直し"));
});

// ---------- 認識のヒント ----------

type AsrContextPatch = { patch: { asrContext?: string } };
async function asrContextPatches(page: Page): Promise<string[]> {
  return (await calls(page, "update_settings"))
    .map((c) => (c.args as AsrContextPatch).patch.asrContext)
    .filter((v): v is string => v != null);
}

test("settings: 認識のヒントは入力が止まるかフォーカスが外れた時に、書いたまま保存する", async ({ page, m }) => {
  await open(page, "window=settings&mock=default&category=recognition", SETTINGS);
  const field = page.getByLabel(m.settings.recognition.context);
  const text = "  開発の話です。\n以下の用語は英字で表記する: Qwen (読み: クウェン、クエン), pnpm  ";
  await field.fill(text);
  // 入力のたびには送らない
  expect(await asrContextPatches(page)).toEqual([]);
  await field.blur();
  // 前後の空白の除去は Rust が行うため、フロントエンドはそのまま送る
  await expect.poll(() => asrContextPatches(page)).toEqual([text]);
  // 入力が止まれば、フォーカスがあるままでも保存する
  await field.focus();
  await field.press("End");
  await field.pressSequentially("、Tauri");
  await expect.poll(() => asrContextPatches(page)).toEqual([text, `${text}、Tauri`]);
  await expect(field).toBeFocused();
});

test("settings: 認識のヒントの文字数は Unicode スカラー値で数え、上限を超えると知らせる", async ({ page, m, ui }) => {
  await open(page, "window=settings&mock=default&category=recognition", SETTINGS);
  const field = page.getByLabel(m.settings.recognition.context);
  // UTF-16 でサロゲートペアになる文字 (𩸽) も 1 文字と数える
  await field.fill("𩸽".repeat(1000));
  await expect(page.getByText("1000 / 1000")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  // Rust と同じく前後の空白を除いて数える (末尾の改行だけで超過にしない)
  await field.fill("𩸽".repeat(1000) + "\n");
  await expect(page.getByText("1000 / 1000")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await field.blur();
  await expect.poll(async () => (await asrContextPatches(page)).at(-1)).toBe("𩸽".repeat(1000) + "\n");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await field.fill("𩸽".repeat(1000) + "あ");
  await expect(page.getByText("1001 / 1000")).toBeVisible();
  await expect(page.getByRole("alert")).toBeVisible();
  // 保存できない値でも、フォーカスが外れて入力が消えない。Rust の拒否を表示する
  await field.blur();
  await expect(page.getByRole("alert")).toHaveText(ui.reject.asrContextMax(1000));
  await expect(field).toHaveValue("𩸽".repeat(1000) + "あ");
  // 上限内に戻すと保存でき、エラーは消える
  await field.fill("短いヒント");
  await field.blur();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect.poll(async () => (await asrContextPatches(page)).at(-1)).toBe("短いヒント");
});

test("settings: 認識のヒントは待ち時間内にページが隠れても保存し、変換中の値は送らない", async ({ page, m }) => {
  // 待ち時間 (800ms) を実時間で過ごすと、遅い CI では pagehide の前に保存されてしまうため時計を止める
  await page.clock.install();
  await open(page, "window=settings&mock=default&category=recognition", SETTINGS);
  await pauseClock(page);
  const field = page.getByLabel(m.settings.recognition.context);
  await field.fill("閉じる直前の入力");
  // 変換中の入力 (確定前) を再現する。React の onChange に届くよう、ネイティブの setter で値を変えてから input を送る
  await field.evaluate((el: HTMLTextAreaElement) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, "閉じる直前の入力へんかん");
    el.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
  });
  await expect(field).toHaveValue("閉じる直前の入力へんかん");
  expect(await asrContextPatches(page)).toEqual([]);
  // フォーカスを外さず、待ち時間 (800ms) 内にウィンドウを閉じた時に相当する
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
  await expect.poll(() => asrContextPatches(page)).toEqual(["閉じる直前の入力"]);
  await expect(field).toBeFocused();
});

// ---------- AppStatus.seq ----------

test("panel: seq が前回より小さい status-changed は捨てる", async ({ page, m }) => {
  await open(page, "window=panel&mock=off", PANEL);
  await expect(page.getByRole("button", { name: m.panel.turnOn })).toBeVisible();
  await mock(page, `api.fire("status-changed", { phase: "listening", loadingProgress: null, error: null, seq: 5 });`);
  await expect(page.getByText(m.panel.idle)).toBeVisible();
  // 遅れて届いた古い状態
  await mock(page, `api.fire("status-changed", { phase: "off", loadingProgress: null, error: null, seq: 3 });`);
  await page.waitForTimeout(200);
  await expect(page.getByText(m.panel.idle)).toBeVisible();
  await mock(page, `api.fire("status-changed", { phase: "off", loadingProgress: null, error: null, seq: 6 });`);
  await expect(page.getByRole("button", { name: m.panel.turnOn })).toBeVisible();
});

test("mock: status を変えるたびに seq を増やす", async ({ page, m }) => {
  await open(page, "window=panel&mock=off", PANEL);
  const seq = () => page.evaluate(() => (window as unknown as { __mukuchiMock: { db: { status: { seq: number } } } }).__mukuchiMock.db.status.seq);
  const before = await seq();
  await page.getByRole("button", { name: m.panel.turnOn }).click();
  await expect(page.getByText(m.panel.idle)).toBeVisible();
  await expect.poll(seq).toBe(before + 1);
  await mock(page, `api.setStatus({ phase: "speaking" });`);
  await expect.poll(seq).toBe(before + 2);
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
