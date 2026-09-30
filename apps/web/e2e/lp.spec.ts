import { expect, test, type Page } from "@playwright/test";
import { DOWNLOAD_URL } from "../app/lib/site";

const PC = { width: 1280, height: 800 };
const SP = { width: 390, height: 844 };

interface FakeNavigator {
  userAgent: string;
  platform: string;
  maxTouchPoints?: number;
  // undefined なら UA-CH なし (Safari・Firefox)
  uaData?: { platform: string; mobile: boolean; architecture?: string };
}

const MAC_CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const ENVS = {
  macArm: {
    userAgent: MAC_CHROME_UA,
    platform: "MacIntel",
    uaData: { platform: "macOS", mobile: false, architecture: "arm" },
  },
  macIntel: {
    userAgent: MAC_CHROME_UA,
    platform: "MacIntel",
    uaData: { platform: "macOS", mobile: false, architecture: "x86" },
  },
  macSafari: {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
    platform: "MacIntel",
    maxTouchPoints: 0,
  },
  windows: {
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    platform: "Win32",
    uaData: { platform: "Windows", mobile: false, architecture: "x86" },
  },
  linux: {
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    platform: "Linux x86_64",
    uaData: { platform: "Linux", mobile: false, architecture: "x86" },
  },
  iphone: {
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
    maxTouchPoints: 5,
  },
} satisfies Record<string, FakeNavigator>;

/** 判定に使う navigator の値を差し替える (実際の OS に依存せずに各状態を確認する) */
async function fakeNavigator(page: Page, env: FakeNavigator) {
  await page.addInitScript((e: FakeNavigator) => {
    const def = (key: string, value: unknown) =>
      Object.defineProperty(Navigator.prototype, key, { get: () => value, configurable: true });
    def("userAgent", e.userAgent);
    def("platform", e.platform);
    def("maxTouchPoints", e.maxTouchPoints ?? 0);
    def(
      "userAgentData",
      e.uaData
        ? {
            platform: e.uaData.platform,
            mobile: e.uaData.mobile,
            getHighEntropyValues: async () => ({ architecture: e.uaData?.architecture }),
          }
        : undefined,
    );
  }, env);
}

const heroPc = (page: Page) => page.getByTestId("hero-cta-pc");

test.describe("PC", () => {
  test.use({ viewport: PC });

  test("主要なセクションと仕様どおりの値を表示する", async ({ page }) => {
    // ハイドレーションの不一致などをコンソールのエラーで検出する
    const errors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(m.text());
    });
    await fakeNavigator(page, ENVS.macArm);
    await page.goto("/");
    await expect(page).toHaveTitle(/mukuchi/);
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "話した言葉だけを、そのまま入力。",
    );
    for (const id of ["features", "privacy", "setup"]) {
      await expect(page.locator(`#${id}`)).toBeVisible();
      await expect(page.locator(`nav a[href="#${id}"]`)).toBeVisible();
    }

    const commands = page.getByTestId("voice-commands");
    await expect(commands.locator("li")).toHaveText([
      "「確定」Enter",
      "「エンター」Enter",
      "「改行」⇧ + Enter",
      "「送信」⌘ + Enter",
    ]);
    await expect(page.getByText("取り消し")).toHaveCount(0);

    const reqs = page.locator("#requirements dl");
    await expect(reqs).toContainText("macOS 13 Ventura 以降");
    await expect(reqs).toContainText("空き容量 6 GB 以上");
    await expect(page.getByText("モデル（約 4.1 GB）", { exact: false })).toBeVisible();
    await expect(page.getByText("モデルの取得以外に通信しません。")).toBeVisible();
    await expect(heroPc(page)).toContainText("36 MB");
    await expect(page.getByTestId("cta-note").first()).toHaveText(/検出しました/);
    expect(errors).toEqual([]);
  });

  test("Apple Silicon (Chrome・Edge) はダウンロードできる", async ({ page }) => {
    await fakeNavigator(page, ENVS.macArm);
    await page.goto("/");
    await expect(page.getByTestId("cta-note").first()).toHaveText(
      "Apple Silicon 搭載の Mac を検出しました",
    );
    const link = heroPc(page).getByRole("link", { name: "Mac 版をダウンロード" });
    await expect(link).toHaveAttribute("href", DOWNLOAD_URL);
    await expect(page.locator("header").getByRole("link", { name: "ダウンロード" })).toBeVisible();
  });

  test("判定できない Mac (Safari・Firefox) はダウンロードでき、Intel 非対応を注記する", async ({
    page,
  }) => {
    await fakeNavigator(page, ENVS.macSafari);
    await page.goto("/");
    await expect(page.getByTestId("cta-note").first()).toHaveText(
      "Intel 搭載の Mac では動作しません",
    );
    await expect(heroPc(page).getByRole("link", { name: "Mac 版をダウンロード" })).toBeVisible();
  });

  const unavailable = [
    { name: "Intel Mac", env: ENVS.macIntel, label: "Apple Silicon 専用です", short: "非対応" },
    { name: "Windows", env: ENVS.windows, label: "Windows 版は準備中", short: "準備中" },
    { name: "Linux", env: ENVS.linux, label: "Linux 版は準備中", short: "準備中" },
  ];
  for (const u of unavailable) {
    test(`${u.name} はダウンロードボタンを無効にする`, async ({ page }) => {
      await fakeNavigator(page, u.env);
      await page.goto("/");
      await expect(heroPc(page).getByRole("button", { name: u.label })).toBeDisabled();
      await expect(page.locator("header").getByRole("button", { name: u.short })).toBeDisabled();
      await expect(page.locator(`a[href="${DOWNLOAD_URL}"]`)).toHaveCount(0);
    });
  }

  test("開発時は ?os= で状態を切り替えられる", async ({ page }) => {
    await fakeNavigator(page, ENVS.macArm);
    await page.goto("/?os=mac-intel");
    await expect(
      heroPc(page).getByRole("button", { name: "Apple Silicon 専用です" }),
    ).toBeDisabled();
  });

  test("スクリーンショット (1280px)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await fakeNavigator(page, ENVS.macArm);
    await page.goto("/");
    await expect(page.getByTestId("cta-note").first()).toHaveText(/検出しました/);
    await expect(page.getByText("話し終えると、カーソル位置に入力します")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: "e2e/screenshots/pc-1280.png", fullPage: true });
  });
});

test.describe("SP", () => {
  test.use({ viewport: SP });

  test("スマホでは URL のコピーと共有を出す", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await fakeNavigator(page, ENVS.iphone);
    await page.goto("/");
    const cta = page.getByTestId("hero-cta-sp");
    await expect(cta.getByRole("button", { name: "共有" })).toBeVisible();
    await expect(page.locator(`a[href="${DOWNLOAD_URL}"]`)).toHaveCount(0);
    await cta.getByRole("button", { name: "URL をコピー" }).click();
    await expect(cta.getByRole("button", { name: "コピーしました" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
      /^http:\/\/localhost:\d+\/$/,
    );
  });

  test("幅の狭い Mac のウィンドウではダウンロードボタンを出す", async ({ page }) => {
    await fakeNavigator(page, ENVS.macArm);
    await page.goto("/");
    await expect(
      page.getByTestId("hero-cta-sp").getByRole("link", { name: "Mac 版をダウンロード" }),
    ).toBeVisible();
  });

  test("スクリーンショット (390px)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await fakeNavigator(page, ENVS.iphone);
    await page.goto("/");
    // ハイドレーション後 (動きを減らす設定で止めた場面) を撮る
    await expect(page.getByText("話し終えると、カーソル位置に入力します")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: "e2e/screenshots/sp-390.png", fullPage: true });
  });
});
