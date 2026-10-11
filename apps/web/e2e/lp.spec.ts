import { expect, test, type Page } from "@playwright/test";
import { en } from "../app/i18n/en";
import { ja, type Messages } from "../app/i18n/ja";
import { pickAvail, type Avail } from "../app/lib/content";
import type { CtaTextKey } from "../app/lib/platform";
import { COMPANY_URL, DMG_URL, NSIS_URL, SITE_URL, googlePartnerSitesUrl } from "../app/lib/site";

// 日本語のページの確認はブラウザの言語を日本語にする (日本語以外だと `/` は `/en/` へ移る)
test.use({ locale: "ja-JP" });

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

const WIN_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

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
  windowsX64: {
    userAgent: WIN_CHROME_UA,
    platform: "Win32",
    uaData: { platform: "Windows", mobile: false, architecture: "x86" },
  },
  windowsArm: {
    userAgent: WIN_CHROME_UA,
    platform: "Win32",
    uaData: { platform: "Windows", mobile: false, architecture: "arm" },
  },
  // Firefox は UA-CH がなく、x64 と ARM を区別できない (x64 とみなす)
  windowsFirefox: {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0",
    platform: "Win32",
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

const scriptMs = (m: Messages, mode: "always" | "once") =>
  m.demo.scripts.macos[mode].reduce((sum, st) => sum + st.ms, 0);
/** 常に聞き取る → 1回ずつ聞き取る の 1 巡 (最後まで進むと交互に替わる) */
const demoCycleMs = (m: Messages) => scriptMs(m, "always") + scriptMs(m, "once");
const DEMO_CYCLE_MS = demoCycleMs(ja);

/** 開発サーバーの critical CSS が外れ、フォントを読み終えるまで待つ (時計を止めている時用) */
async function settleDevCss(page: Page) {
  // 開発サーバーでは、ハイドレーション後に React Router が開発時だけの critical CSS を外す。
  // その時に @font-face が読み直されて一時的に代替フォントで描画され、後続の位置がずれる。
  // 時計を止めているので外れるまで進め、フォントを読み終えてから計測する (本番の出力には無い)
  const criticalCss = page.locator("[data-react-router-critical-css]");
  for (let i = 0; i < 100 && (await criticalCss.count()) > 0; i++) {
    await page.clock.runFor(100);
  }
  await expect(criticalCss).toHaveCount(0);
  await page.evaluate(() => {
    // レイアウトを確定させて、外れた後に必要になったフォントの読み込みを始めさせる
    void document.body.offsetHeight;
    return document.fonts.ready;
  });
}

/**
 * 時計を止めないテストでクリックする前に、開発サーバー特有の後からの変化を待つ。ハイドレーション後に
 * critical CSS が外れてフォントが読み直されると後続の位置がずれ、ページ下部のリンクのクリックが空振りする
 * (CI でフッターの言語の切り替えから移動しなかった)。読み込み中の依存の最適化による読み直しも待つ
 */
async function settleBeforeClick(page: Page) {
  await page.waitForLoadState("networkidle");
  await expect(page.locator("[data-react-router-critical-css]")).toHaveCount(0);
  await page.evaluate(() => {
    void document.body.offsetHeight;
    return document.fonts.ready;
  });
}

/**
 * デモを 2 巡分 (両方のモードを 2 回ずつ) 動かしながら、デモの高さと直後のセクションの位置が変わらないこと、
 * 固定した各部から中身がはみ出さないことを確かめる (時計を止めて決まった間隔で進める)
 */
async function expectStableDemo(page: Page, path = "/", m: Messages = ja) {
  await page.clock.install();
  await page.goto(path);
  await settleDevCss(page);
  const demo = page.getByTestId("demo");
  await expect(demo).toBeVisible();

  const samples: { height: number; nextY: number; status: string; overflow: string[] }[] = [];
  for (let t = 0; t <= demoCycleMs(m) * 2; t += 100) {
    samples.push(
      await demo.evaluate((el) => {
        const next = document.getElementById("modes")!;
        const overflow = ["demo-sent", "demo-input", "demo-caption"].filter((id) => {
          const part = el.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
          return part.scrollHeight > part.clientHeight || part.scrollWidth > part.clientWidth;
        });
        return {
          height: el.getBoundingClientRect().height,
          nextY: next.getBoundingClientRect().top + window.scrollY,
          status: el.textContent ?? "",
          overflow,
        };
      }),
    );
    await page.clock.runFor(100);
  }

  // 両方のモードの全場面を通ったこと (キー操作・聞き取り中の場面まで進んでいる)
  const { status, modeMeta } = m.demo;
  for (const word of [
    status.key,
    status.recognizing,
    status.listening,
    modeMeta.macos.always.appName,
    modeMeta.macos.once.appName,
  ]) {
    expect(samples.some((x) => x.status.includes(word))).toBe(true);
  }
  expect(new Set(samples.map((x) => x.height))).toEqual(new Set([samples[0].height]));
  expect(new Set(samples.map((x) => x.nextY))).toEqual(new Set([samples[0].nextY]));
  expect(samples.flatMap((x) => x.overflow)).toEqual([]);
}

async function expectCompanyLink(page: Page, m: Messages = ja) {
  const footer = page.locator("footer");
  await expect(footer).toContainText(`© 2026 ${m.footer.company}`);
  await expect(footer.getByRole("link", { name: m.footer.company })).toHaveAttribute(
    "href",
    COMPANY_URL,
  );
}

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
    for (const id of ["modes", "features", "privacy", "setup"]) {
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
    // アプリが未対応の音声コマンド「取り消し」を載せない (入力モードの「聞き取りを取り消します」は別の話なので特長の中だけを見る)
    await expect(page.locator("#features").getByText("取り消し")).toHaveCount(0);

    const reqs = page.getByTestId("requirements-macos");
    await expect(reqs).toContainText("macOS 13 Ventura 以降");
    await expect(reqs).toContainText("空き容量 6 GB 以上");
    await expect(reqs).toContainText("動作確認M1 Max・M3 Pro");
    await expect(reqs).toContainText("Qwen3-ASR 1.7B（日本語・約 2.2 GB）");
    await expect(
      page
        .getByTestId("setup-steps-macos")
        .getByText("Qwen3-ASR 1.7B（約 2.2 GB）をダウンロードします。"),
    ).toBeVisible();
    await expect(
      page.getByText(
        "音声認識モデルのダウンロードと、アップデートの確認・ダウンロード以外に通信しません。アップデートの自動確認は設定で止められます。",
      ),
    ).toBeVisible();
    await expect(heroPc(page)).toContainText("36 MB");
    await expect(page.getByTestId("cta-note").first()).toHaveText(/検出しました/);
    await expectCompanyLink(page);
    expect(errors).toEqual([]);
  });

  test("入力モードの節に 2 つのモードを並べ、ヘッダーから移動できる", async ({ page }) => {
    await fakeNavigator(page, ENVS.macArm);
    await page.goto("/");
    // テストを並列に増やしたことで、ハイドレーション・critical CSS の外れより先にクリックして空振りすることがあった
    await settleBeforeClick(page);
    await page.locator('header nav a[href="#modes"]').click();
    await expect(page).toHaveURL(/#modes$/);
    const modes = page.locator("#modes");
    await expect(modes).toBeInViewport();
    await expect(modes.getByRole("heading", { level: 2 })).toHaveText(
      "聞き取り方は、2 つから選べます",
    );
    await expect(modes).toContainText(ja.modes.lead);
    const always = page.getByTestId("mode-always");
    const once = page.getByTestId("mode-once");
    await expect(always.getByRole("heading")).toHaveText("常に聞き取る");
    await expect(once.getByRole("heading")).toHaveText("1回ずつ聞き取る");
    // 既定のバッジは常に聞き取るだけ
    await expect(always.getByText("既定", { exact: true })).toBeVisible();
    await expect(once.getByText("既定", { exact: true })).toHaveCount(0);
    await expect(always.locator("dt")).toHaveCount(1);
    await expect(once.locator("dt")).toHaveCount(4);
    await expect(once).toContainText("⌥Space → 1 回分を入力");
    await expect(modes).toContainText("どのアプリを使っていても、⌥Space で操作できます");
  });

  test("セットアップは 5 ステップ", async ({ page }) => {
    await fakeNavigator(page, ENVS.macArm);
    await page.goto("/");
    const steps = page.getByTestId("setup-steps-macos").locator("li");
    await expect(steps).toHaveCount(5);
    expect(ja.setup.steps.macos).toHaveLength(5);
    expect(ja.setup.steps.windows).toHaveLength(5);
    await expect(steps.nth(0)).toContainText("dmg（約 36 MB）");
    await expect(steps.nth(3)).toContainText("入力モードとショートカットを選ぶ");
    await expect(steps.nth(3)).toContainText("既定は ⌥Space");
    await expect(page.locator("#setup")).toContainText(
      "アカウント登録は不要です。モデルのダウンロードを含めて約 5 分で完了します。",
    );
  });

  test("デモは 2 つのモードを交互に再生し、タブを押すとそのモードに固定する", async ({ page }) => {
    await fakeNavigator(page, ENVS.macArm);
    await page.clock.install();
    await page.goto("/");
    await settleDevCss(page);
    const demo = page.getByTestId("demo");
    const appName = page.getByTestId("demo-app-name");
    const tab = (name: string) => demo.getByRole("button", { name });
    await expect(appName).toHaveText("AI チャット");
    await expect(tab("常に聞き取る")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("demo-mode-note")).toHaveText("既定のモード");

    // 常に聞き取るを最後まで進めると、1回ずつ聞き取るに替わる (critical CSS 待ちで進めた分を差し引くため時刻ではなく表示で待つ)
    for (let i = 0; i < 200 && (await appName.textContent()) !== "メモ"; i++) {
      await page.clock.runFor(100);
    }
    await expect(appName).toHaveText("メモ");
    await expect(tab("1回ずつ聞き取る")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("demo-status")).toHaveText("オフ");
    await expect(page.getByTestId("demo-mode-note")).toHaveText("⌥Space で 1 回分を入力");

    // タブで常に聞き取るを選ぶと、何巡しても替わらない
    await tab("常に聞き取る").click();
    await expect(appName).toHaveText("AI チャット");
    await expect(page.getByTestId("demo-status")).toHaveText("待機中");
    for (let t = 0; t < DEMO_CYCLE_MS * 2; t += 500) {
      await page.clock.runFor(500);
      await expect(appName).toHaveText("AI チャット");
    }

    await tab("1回ずつ聞き取る").click();
    await expect(appName).toHaveText("メモ");
    await page.clock.runFor(DEMO_CYCLE_MS * 2);
    await expect(appName).toHaveText("メモ");
  });

  test("開発時は ?heroMode= でデモのモードを固定できる", async ({ page }) => {
    await fakeNavigator(page, ENVS.macArm);
    await page.clock.install();
    await page.goto("/?heroMode=once");
    await settleDevCss(page);
    const appName = page.getByTestId("demo-app-name");
    await expect(appName).toHaveText("メモ");
    await page.clock.runFor(DEMO_CYCLE_MS * 2);
    await expect(appName).toHaveText("メモ");
  });

  test("Apple Silicon (Chrome・Edge) はダウンロードできる", async ({ page }) => {
    await fakeNavigator(page, ENVS.macArm);
    await page.goto("/");
    await expect(page.getByTestId("cta-note").first()).toHaveText(
      "Apple Silicon 搭載の Mac を検出しました",
    );
    const link = heroPc(page).getByRole("link", { name: "Mac 版をダウンロード" });
    await expect(link).toHaveAttribute("href", DMG_URL);
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
    {
      name: "Windows (公開前)",
      env: ENVS.windowsX64,
      label: "Windows 版は準備中",
      short: "準備中",
    },
    { name: "Linux (公開前)", env: ENVS.linux, label: "Mac 版のみ", short: "Mac 版のみ" },
  ];
  for (const u of unavailable) {
    test(`${u.name} はダウンロードボタンを無効にする`, async ({ page }) => {
      await fakeNavigator(page, u.env);
      await page.goto("/?windowsAvailable=0");
      await expect(heroPc(page).getByRole("button", { name: u.label })).toBeDisabled();
      await expect(page.locator("header").getByRole("button", { name: u.short })).toBeDisabled();
      await expect(page.locator('[data-cta="download"]')).toHaveCount(0);
    });
  }

  test("開発時は ?os= で状態を切り替えられる", async ({ page }) => {
    await fakeNavigator(page, ENVS.macArm);
    await page.goto("/?os=mac-intel");
    await expect(
      heroPc(page).getByRole("button", { name: "Apple Silicon 専用です" }),
    ).toBeDisabled();
  });

  test("開発時は GA を読み込まず、フッターに計測の表記を出す", async ({ page }) => {
    const gaRequests: string[] = [];
    page.on("request", (r) => {
      if (/googletagmanager\.com|google-analytics\.com/.test(r.url())) gaRequests.push(r.url());
    });
    await fakeNavigator(page, ENVS.macArm);
    await page.goto("/");
    const notice = page.getByTestId("analytics-notice");
    await expect(notice).toContainText("Google Analytics");
    await expect(notice.getByRole("link")).toHaveAttribute("href", googlePartnerSitesUrl("ja"));
    expect(await page.evaluate(() => typeof window.gtag)).toBe("undefined");
    expect(gaRequests).toEqual([]);
  });

  test("デモが動いても高さと後続の位置が変わらない (1280px)", async ({ page }) => {
    await fakeNavigator(page, ENVS.macArm);
    await expectStableDemo(page);
  });

  test("デモが動いても高さと後続の位置が変わらない (1024px)", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await fakeNavigator(page, ENVS.macArm);
    await expectStableDemo(page);
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
    await expect(page.locator('[data-cta="download"]')).toHaveCount(0);
    // ハイドレーション前に押すと何も起きない (コピーは JS の操作)
    await settleBeforeClick(page);
    await cta.getByRole("button", { name: "URL をコピー" }).click();
    await expect(cta.getByRole("button", { name: "コピーしました" })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
      /^http:\/\/localhost:\d+\/$/,
    );
  });

  test("フッターの会社名は会社のサイトへのリンク", async ({ page }) => {
    await fakeNavigator(page, ENVS.iphone);
    await page.goto("/");
    await expectCompanyLink(page);
  });

  test("デモが動いても高さと後続の位置が変わらない (390px)", async ({ page }) => {
    await fakeNavigator(page, ENVS.iphone);
    await expectStableDemo(page);
  });

  test("デモが動いても高さと後続の位置が変わらない (320px)", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await fakeNavigator(page, ENVS.iphone);
    await expectStableDemo(page);
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

// ---- 言語 (日本語 `/`・英語 `/en/`) ----

/** 言語ごとのページを相互に示す meta (hreflang・canonical・og:locale) */
async function expectLocaleMeta(page: Page, locale: "ja" | "en") {
  const head = page.locator("head");
  const url = locale === "ja" ? `${SITE_URL}/` : `${SITE_URL}/en/`;
  await expect(head.locator('link[rel="canonical"]')).toHaveAttribute("href", url);
  await expect(head.locator('link[rel="alternate"][hreflang="ja"]')).toHaveAttribute(
    "href",
    `${SITE_URL}/`,
  );
  await expect(head.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute(
    "href",
    `${SITE_URL}/en/`,
  );
  await expect(head.locator('link[rel="alternate"][hreflang="x-default"]')).toHaveAttribute(
    "href",
    `${SITE_URL}/en/`,
  );
  const [og, alt] = locale === "ja" ? ["ja_JP", "en_US"] : ["en_US", "ja_JP"];
  await expect(head.locator('meta[property="og:locale"]')).toHaveAttribute("content", og);
  await expect(head.locator('meta[property="og:locale:alternate"]')).toHaveAttribute(
    "content",
    alt,
  );
  await expect(head.locator('meta[property="og:url"]')).toHaveAttribute("content", url);
}

test.describe("言語 PC", () => {
  test.use({ viewport: PC });

  test("日本語のページは lang=ja で、英語のページを相互に示す", async ({ page }) => {
    await fakeNavigator(page, ENVS.macArm);
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expectLocaleMeta(page, "ja");
    await expect(page.locator('head meta[property="og:image"]')).toHaveAttribute(
      "content",
      `${SITE_URL}/og-image.jpg`,
    );
    await expect(page.locator("footer")).toContainText("© 2026 株式会社 Minimal");
  });

  test("英語のページの主要な文言と値", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await fakeNavigator(page, ENVS.macArm);
    await page.goto("/en/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page).toHaveTitle(en.meta.title);
    await expectLocaleMeta(page, "en");
    await expect(page.locator('head meta[property="og:image"]')).toHaveAttribute(
      "content",
      `${SITE_URL}/og-image-en.jpg`,
    );
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Just speak.Only your words get typed.",
    );
    for (const id of ["modes", "features", "privacy", "setup"]) {
      await expect(page.locator(`#${id}`)).toBeVisible();
    }
    await expect(page.getByTestId("voice-commands").locator("li")).toHaveText([
      "“enter”Enter",
      "“new line”⇧ + Enter",
      "“line break”⇧ + Enter",
      "“send”⌘ + Enter",
    ]);
    const reqs = page.getByTestId("requirements-macos");
    await expect(reqs).toContainText("macOS 13 Ventura or later");
    await expect(reqs).toContainText("Speech modelQwen3-ASR 1.7B (about 2.2 GB)");
    await expect(reqs).toContainText("English and Japanese");
    await expect(page.getByTestId("setup-steps-macos").locator("li")).toHaveCount(5);
    await expect(heroPc(page).getByRole("link", { name: "Download for Mac" })).toHaveAttribute(
      "href",
      DMG_URL,
    );
    await expect(heroPc(page)).toContainText("36 MB");
    await expect(page.getByTestId("cta-note").first()).toHaveText(
      "Mac with Apple Silicon detected",
    );
    await expectCompanyLink(page, en);
    await expect(page.locator("footer")).toContainText("© 2026 Minimal, K.K.");
    await expect(page.getByTestId("analytics-notice").getByRole("link")).toHaveAttribute(
      "href",
      googlePartnerSitesUrl("en"),
    );
    expect(errors).toEqual([]);
  });

  test("`/en` (末尾の / なし) でも英語のページを表示する", async ({ page }) => {
    await page.goto("/en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Just speak.");
  });

  test("ヘッダーとフッターの言語の切り替えで、もう一方の言語のページへ移動する", async ({
    page,
  }) => {
    await fakeNavigator(page, ENVS.macArm);
    await page.goto("/");
    await settleBeforeClick(page);
    const header = page.locator("header").getByTestId("language-switch");
    await expect(header.locator('[aria-current="page"]')).toHaveText("日本語");
    await header.getByRole("link", { name: "English" }).click();
    // パスで待つ (正規表現の /\/$/ は /en/ にも当たり移動を待たない)。CI の dev サーバーは初回の
    // 読み込み・依存の最適化で遷移が5秒を超えることがあるため長めに待つ
    await expect(page).toHaveURL((u) => u.pathname === "/en/", { timeout: 15_000 });
    await expect(page.locator("html")).toHaveAttribute("lang", "en");

    await settleBeforeClick(page);
    const footer = page.locator("footer").getByTestId("language-switch");
    await expect(footer.locator('[aria-current="page"]')).toHaveText("English");
    await footer.getByRole("link", { name: "日本語" }).click();
    await expect(page).toHaveURL((u) => u.pathname === "/", { timeout: 15_000 });
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  });

  test("英語のデモは 2 つのモードを交互に再生する", async ({ page }) => {
    await fakeNavigator(page, ENVS.macArm);
    await page.clock.install();
    await page.goto("/en/");
    await settleDevCss(page);
    const appName = page.getByTestId("demo-app-name");
    await expect(appName).toHaveText("AI Chat");
    await expect(
      page.getByTestId("demo").getByRole("button", { name: "Always listen" }),
    ).toHaveAttribute("aria-pressed", "true");
    for (let i = 0; i < 200 && (await appName.textContent()) !== "Notes"; i++) {
      await page.clock.runFor(100);
    }
    await expect(appName).toHaveText("Notes");
    await expect(page.getByTestId("demo-status")).toHaveText("Off");
  });

  test("英語のデモが動いても高さと後続の位置が変わらない (1280px)", async ({ page }) => {
    await fakeNavigator(page, ENVS.macArm);
    await expectStableDemo(page, "/en/", en);
  });

  test("英語のデモが動いても高さと後続の位置が変わらない (1024px)", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await fakeNavigator(page, ENVS.macArm);
    await expectStableDemo(page, "/en/", en);
  });

  test("スクリーンショット 英語 (1280px)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await fakeNavigator(page, ENVS.macArm);
    await page.goto("/en/");
    await expect(page.getByTestId("cta-note").first()).toHaveText(/detected/);
    await expect(page.getByText("When you finish, it's typed at the cursor")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: "e2e/screenshots/pc-1280-en.png", fullPage: true });
  });
});

test.describe("英語のブラウザで `/` を開いた時", () => {
  test.use({ viewport: PC, locale: "en-US" });

  test("`/en/` へ移り、クエリとハッシュを引き継ぐ", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await page.goto("/?utm_source=x#features");
    await expect(page).toHaveURL(
      (u) => u.pathname === "/en/" && u.search === "?utm_source=x" && u.hash === "#features",
    );
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Just speak.");
    expect(errors).toEqual([]);
  });

  test("言語の切り替えで日本語を選ぶと、次に `/` を開いても日本語のまま", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL((u) => u.pathname === "/en/");
    await settleBeforeClick(page);
    await page
      .locator("footer")
      .getByTestId("language-switch")
      .getByRole("link", { name: "日本語" })
      .click();
    await expect(page).toHaveURL((u) => u.pathname === "/", { timeout: 15_000 });
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await expect(page).toHaveURL((u) => u.pathname === "/");

    // 英語を選び直すと、また `/` から英語へ移る
    await settleBeforeClick(page);
    await page
      .locator("header")
      .getByTestId("language-switch")
      .getByRole("link", { name: "English" })
      .click();
    await expect(page).toHaveURL((u) => u.pathname === "/en/", { timeout: 15_000 });
    await page.goto("/");
    await expect(page).toHaveURL((u) => u.pathname === "/en/");
  });

  test("localStorage が使えなくても、サイト内から日本語を選べば日本語のまま", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new DOMException("denied", "SecurityError");
        },
      });
    });
    await page.goto("/");
    await expect(page).toHaveURL((u) => u.pathname === "/en/");
    await settleBeforeClick(page);
    await page
      .locator("footer")
      .getByTestId("language-switch")
      .getByRole("link", { name: "日本語" })
      .click();
    await expect(page).toHaveURL((u) => u.pathname === "/", { timeout: 15_000 });
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  });

  test("クローラーは移さない", async ({ page }) => {
    await fakeNavigator(page, {
      ...ENVS.macArm,
      userAgent:
        "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/140.0.0.0 Safari/537.36",
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page).toHaveURL((u) => u.pathname === "/");
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  });
});

test("日本語のブラウザでは `/` を日本語のまま出す", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page).toHaveURL((u) => u.pathname === "/");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
});

test.describe("言語 SP", () => {
  test.use({ viewport: SP });

  test("英語のスマホ版は URL のコピーと共有を出す", async ({ page }) => {
    await fakeNavigator(page, ENVS.iphone);
    await page.goto("/en/");
    const cta = page.getByTestId("hero-cta-sp");
    await expect(cta.getByRole("button", { name: "Copy URL" })).toBeVisible();
    await expect(cta.getByRole("button", { name: "Share" })).toBeVisible();
    await expect(page.locator("header").getByTestId("language-switch")).toBeVisible();
  });

  test("英語のデモが動いても高さと後続の位置が変わらない (390px)", async ({ page }) => {
    await fakeNavigator(page, ENVS.iphone);
    await expectStableDemo(page, "/en/", en);
  });

  test("英語のデモが動いても高さと後続の位置が変わらない (320px)", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await fakeNavigator(page, ENVS.iphone);
    await expectStableDemo(page, "/en/", en);
  });

  test("スクリーンショット 英語 (390px)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await fakeNavigator(page, ENVS.iphone);
    await page.goto("/en/");
    await expect(page.getByText("When you finish, it's typed at the cursor")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: "e2e/screenshots/sp-390-en.png", fullPage: true });
  });
});

// ---- Mac / Windows の 2 OS (docs/plans/windows-plan.md §10.3) ----

const LOCALE_PAGES = [
  { name: "ja", path: "/", m: ja },
  { name: "en", path: "/en/", m: en },
] as const;

/** 辞書の文言を Windows 版の公開状況で選ぶ */
const pick = (v: string | Avail<string> | undefined, available: boolean) =>
  pickAvail(v ?? "", available);

/** 開発時の上書きで公開状況を固定して開く (既定値 WINDOWS_AVAILABLE に依存しない) */
const withAvail = (path: string, available: boolean) =>
  `${path}?windowsAvailable=${available ? 1 : 0}`;

interface CtaCase {
  name: string;
  env: FakeNavigator;
  available: boolean;
  /** 主ボタンの文言のキー。download は成果物の OS */
  text: CtaTextKey;
  download?: "macos" | "windows";
  /** ボタンの下のほかの OS 版へのリンク */
  alt: string[];
  share?: boolean;
}

const CTA_CASES: CtaCase[] = [
  {
    name: "mac-arm",
    env: ENVS.macArm,
    available: false,
    text: "mac-arm",
    download: "macos",
    alt: [],
  },
  {
    name: "mac-arm",
    env: ENVS.macArm,
    available: true,
    text: "mac-arm",
    download: "macos",
    alt: [NSIS_URL],
  },
  {
    name: "mac (Safari)",
    env: ENVS.macSafari,
    available: true,
    text: "mac-unknown",
    download: "macos",
    alt: [NSIS_URL],
  },
  {
    name: "windows-x64",
    env: ENVS.windowsX64,
    available: false,
    text: "windows-soon",
    alt: [DMG_URL],
  },
  {
    name: "windows-x64",
    env: ENVS.windowsX64,
    available: true,
    text: "windows-x64",
    download: "windows",
    alt: [DMG_URL],
  },
  {
    name: "windows (Firefox)",
    env: ENVS.windowsFirefox,
    available: true,
    text: "windows-x64",
    download: "windows",
    alt: [DMG_URL],
  },
  {
    name: "windows-arm",
    env: ENVS.windowsArm,
    available: false,
    text: "windows-soon",
    alt: [DMG_URL],
  },
  {
    name: "windows-arm",
    env: ENVS.windowsArm,
    available: true,
    text: "windows-arm",
    alt: [DMG_URL],
  },
  { name: "linux", env: ENVS.linux, available: false, text: "linux", alt: [DMG_URL], share: true },
  {
    name: "linux",
    env: ENVS.linux,
    available: true,
    text: "linux",
    alt: [DMG_URL, NSIS_URL],
    share: true,
  },
];

test.describe("OS ごとの主ボタン PC", () => {
  test.use({ viewport: PC });

  for (const { name: lang, path, m } of LOCALE_PAGES) {
    for (const c of CTA_CASES) {
      const avail = c.available ? "公開後" : "公開前";
      test(`${lang} ${c.name} (Windows ${avail})`, async ({ page }) => {
        await fakeNavigator(page, c.env);
        await page.goto(withAvail(path, c.available));
        const hero = heroPc(page);
        const state = m.cta.states[c.text];
        await expect(hero.getByTestId("cta-note")).toHaveText(pick(state.note, c.available));
        if (c.download) {
          const label = state.label ?? m.cta.download[c.download].label;
          const link = hero.locator('[data-cta="download"]');
          await expect(link).toHaveText(pick(label, c.available));
          await expect(link).toHaveAttribute("href", c.download === "macos" ? DMG_URL : NSIS_URL);
          await expect(hero.getByTestId("download-meta")).toHaveText(m.downloadMeta[c.download]);
        } else {
          await expect(hero.locator('[data-cta="download"]')).toHaveCount(0);
          await expect(
            hero.getByRole("button", { name: pick(state.label, c.available) }),
          ).toBeDisabled();
        }
        const alt = hero.getByTestId("cta-alt").locator("a");
        if (c.alt.length === 0) {
          await expect(hero.getByTestId("cta-alt")).toHaveCount(0);
        } else {
          await expect(alt).toHaveCount(c.alt.length);
          for (const [i, href] of c.alt.entries()) {
            await expect(alt.nth(i)).toHaveAttribute("href", href);
          }
        }
        await expect(hero.getByRole("button", { name: m.cta.copyUrl })).toHaveCount(
          c.share ? 1 : 0,
        );
        // 公開前は Windows のインストーラーへのリンクをどこにも出さない
        if (!c.available) await expect(page.locator(`a[href="${NSIS_URL}"]`)).toHaveCount(0);
      });
    }
  }

  test("判定前 (事前生成の HTML) は OS 中立のボタンで、動作要件へ移る", async ({ page }) => {
    // 判定を終わらせないよう、UA-CH の応答を返さない
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "userAgentData", {
        get: () => ({
          platform: "Windows",
          mobile: false,
          getHighEntropyValues: () => new Promise(() => {}),
        }),
        configurable: true,
      });
    });
    await page.goto(withAvail("/", true));
    const button = heroPc(page).locator('[data-cta="pending"]');
    await expect(button).toHaveText(ja.cta.states.pending.label as string);
    await expect(button).toHaveAttribute("href", "#requirements");
    await expect(heroPc(page).getByTestId("cta-note")).toHaveText(
      pick(ja.cta.states.pending.note, true),
    );
    await expect(heroPc(page).getByTestId("download-meta")).toHaveText(
      pick(ja.downloadMeta.any, true),
    );
  });

  test("ダウンロードの計測は拡張子と閲覧中の環境を送る", async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { events: unknown[]; gtag: (...a: unknown[]) => void };
      w.events = [];
      w.gtag = (...a) => w.events.push(a);
    });
    // GitHub へは移らない (計測の onClick は動かしたまま、リンクの既定の動作だけ止める)
    await page.addInitScript(() => {
      document.addEventListener(
        "click",
        (e) => {
          if ((e.target as Element).closest('a[href^="https://github.com/"]')) e.preventDefault();
        },
        true,
      );
    });
    await fakeNavigator(page, ENVS.windowsX64);
    await page.goto(withAvail("/", true));
    await settleBeforeClick(page);
    await heroPc(page).locator('[data-cta="download"]').click();
    await heroPc(page).getByTestId("cta-alt").locator("a").click();
    const events = await page.evaluate(() => (window as unknown as { events: unknown[] }).events);
    expect(events).toEqual([
      [
        "event",
        "file_download",
        {
          file_name: "mukuchi_x64-setup.exe",
          file_extension: "exe",
          link_url: NSIS_URL,
          cta_location: "hero",
          platform: "windows-x64",
        },
      ],
      [
        "event",
        "file_download",
        {
          file_name: "mukuchi_aarch64.dmg",
          file_extension: "dmg",
          link_url: DMG_URL,
          cta_location: "hero",
          platform: "windows-x64",
        },
      ],
    ]);
  });

  test("提供状況は公開状況で Windows のバッジを変える", async ({ page }) => {
    await fakeNavigator(page, ENVS.macArm);
    await page.goto(withAvail("/", false));
    const list = page.getByTestId("platform-list");
    await expect(list.locator("li").nth(1)).toHaveText(
      `${ja.cta.platforms.windows}${ja.cta.platforms.comingSoon}`,
    );
    await page.goto(withAvail("/", true));
    await expect(list.locator("li").nth(1)).toHaveText(
      `${ja.cta.platforms.windows}${ja.cta.platforms.available}`,
    );
    // 動作要件の表のダウンロード (公開前の Windows は「準備中」)
    await expect(
      page.getByTestId("requirements-windows").getByTestId("requirements-download"),
    ).toHaveAttribute("href", NSIS_URL);
    await expect(
      page.getByTestId("requirements-macos").getByTestId("requirements-download"),
    ).toHaveAttribute("href", DMG_URL);
  });
});

test.describe("OS のタブ", () => {
  test.use({ viewport: PC });

  for (const { name: lang, path, m } of LOCALE_PAGES) {
    test(`${lang} Mac は macOS を選び、Windows に切り替えられる`, async ({ page }) => {
      await fakeNavigator(page, ENVS.macArm);
      await page.goto(path);
      await settleBeforeClick(page);
      const tabs = page.getByTestId("os-tabs");
      await expect(tabs.getByRole("button", { name: "macOS" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(page.getByTestId("setup-steps-macos")).toBeVisible();
      await expect(page.getByTestId("setup-steps-windows")).toBeHidden();
      await expect(page.locator("#modes")).toContainText(m.modes.shortcut.macos.title);
      await expect(page.getByTestId("voice-commands")).toContainText("⌘ + Enter");
      await expect(page.getByTestId("demo-titlebar")).toHaveAttribute("data-os", "macos");

      await tabs.getByRole("button", { name: "Windows" }).click();
      await expect(tabs.getByRole("button", { name: "Windows" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(page.getByTestId("setup-steps-windows")).toBeVisible();
      await expect(page.getByTestId("setup-steps-macos")).toBeHidden();
      await expect(page.getByTestId("setup-steps-windows").locator("li")).toHaveText(
        m.setup.steps.windows.map((s) => `${s.no}${s.title}${s.body}`),
      );
      // キー表記・常駐場所・デモも同じ OS になる
      await expect(page.locator("#modes")).toContainText(m.modes.shortcut.windows.title);
      await expect(page.locator("#modes")).toContainText(m.modes.shortcut.windows.body);
      await expect(page.getByTestId("voice-commands")).toContainText("Ctrl + Enter");
      await expect(page.getByTestId("demo-titlebar")).toHaveAttribute("data-os", "windows");
      // 主ボタンは閲覧中の環境のまま
      await expect(heroPc(page).locator('[data-cta="download"]')).toHaveAttribute("href", DMG_URL);
    });

    test(`${lang} Windows は Windows を選び、macOS に切り替えられる`, async ({ page }) => {
      await fakeNavigator(page, ENVS.windowsX64);
      await page.goto(path);
      await settleBeforeClick(page);
      const tabs = page.getByTestId("os-tabs");
      await expect(tabs.getByRole("button", { name: "Windows" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(page.getByTestId("setup-steps-windows")).toBeVisible();
      await expect(page.locator("#hero-title + div")).toContainText("Alt Space");
      await tabs.getByRole("button", { name: "macOS" }).click();
      await expect(page.getByTestId("setup-steps-macos")).toBeVisible();
      await expect(page.getByTestId("voice-commands")).toContainText("⌘ + Enter");
    });
  }

  test("Linux・判定できない環境は macOS を選ぶ", async ({ page }) => {
    await fakeNavigator(page, ENVS.linux);
    await page.goto("/");
    await expect(
      page.getByTestId("os-tabs").getByRole("button", { name: "macOS" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("事前生成の HTML", () => {
  // 両 OS の内容が入り (JS なし・クローラー向け)、Mac だけを前提にした文言が残らない
  const MAC_ONLY = {
    ja: [
      "Mac に常駐",
      "Mac 用の音声入力",
      "Mac 用のアプリ",
      "Mac の外に",
      "Mac 上で処理",
      "Mac 版をダウンロード",
    ],
    en: [
      "stays running on your Mac",
      "voice input app for Mac",
      "a Mac app",
      "never leaves your Mac",
      "runs on your Mac",
      "Download for Mac",
    ],
  };

  for (const { name: lang, path, m } of LOCALE_PAGES) {
    test(`${lang} は両 OS の動作要件と手順を含み、Mac だけの文言を含まない`, async ({
      browser,
    }) => {
      // JS なしで開き、ハイドレーション前の HTML (事前生成と同じ出力) をそのまま読む
      const context = await browser.newContext({ javaScriptEnabled: false });
      const page = await context.newPage();
      await page.goto(path);
      const text = (await page.locator("body").textContent()) ?? "";
      const html = await page.content();
      for (const os of ["macos", "windows"] as const) {
        for (const r of m.requirements.rows[os]) expect(text).toContain(r.v);
        for (const s of m.setup.steps[os]) expect(text).toContain(s.body);
      }
      for (const f of m.faq.items) expect(text).toContain(f.q);
      for (const phrase of MAC_ONLY[lang]) {
        expect(text).not.toContain(phrase);
        expect(html).not.toContain(phrase);
      }
      // 判定前のボタンは OS 中立
      await expect(page.locator('[data-cta="pending"]')).toHaveCount(3);
      await expect(page.locator('[data-cta="download"]')).toHaveCount(0);
      await context.close();
    });
  }

  test("meta (hreflang・canonical) は OS で変わらない", async ({ page }) => {
    await fakeNavigator(page, ENVS.windowsX64);
    await page.goto(withAvail("/", true));
    await expectLocaleMeta(page, "ja");
    await fakeNavigator(page, ENVS.windowsArm);
    await page.goto(withAvail("/en/", true));
    await expectLocaleMeta(page, "en");
  });
});

test.describe("OS ごとの表示 SP", () => {
  test.use({ viewport: SP });

  for (const { name: lang, path, m } of LOCALE_PAGES) {
    for (const available of [false, true]) {
      test(`${lang} スマホは Windows の公開状況に合わせて案内する (${available ? "公開後" : "公開前"})`, async ({
        page,
      }) => {
        await fakeNavigator(page, ENVS.iphone);
        await page.goto(withAvail(path, available));
        const cta = page.getByTestId("hero-cta-sp");
        await expect(cta).toContainText(pick(m.hero.desktopOnly, available));
        await expect(cta).toContainText(pick(m.downloadMetaShort, available));
        await expect(page.getByTestId("supported-os")).toHaveText(
          pick(m.footer.supportedOs, available),
        );
      });
    }

    test(`${lang} 幅の狭い Windows のウィンドウではダウンロードボタンを出す`, async ({ page }) => {
      await fakeNavigator(page, ENVS.windowsX64);
      await page.goto(withAvail(path, true));
      await expect(
        page.getByTestId("hero-cta-sp").getByRole("link", { name: m.cta.download.windows.label }),
      ).toHaveAttribute("href", NSIS_URL);
    });
  }
});

test.describe("スクリーンショット Windows", () => {
  // 英語は文字列が長いので、Windows の表示 (注記・動作要件の表・FAQ) の崩れを目で確かめる
  for (const { name: lang, path } of LOCALE_PAGES) {
    for (const vp of [PC, SP]) {
      test(`${lang} ${vp.width}px`, async ({ page }) => {
        await page.setViewportSize(vp);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await fakeNavigator(page, ENVS.windowsX64);
        await page.goto(withAvail(path, true));
        await expect(page.getByTestId("demo-titlebar")).toHaveAttribute("data-os", "windows");
        for (const d of await page.locator("#faq details").all()) {
          await d.evaluate((el) => el.setAttribute("open", ""));
        }
        await page.evaluate(() => document.fonts.ready);
        // 横にはみ出さない
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.screenshot({
          path: `e2e/screenshots/windows-${vp.width}-${lang}.png`,
          fullPage: true,
        });
        // 全体だと縮小されて読めないので、注記・表の多い部分は要素ごとにも撮る
        const parts = {
          hero: page.locator('section[aria-labelledby="hero-title"]'),
          setup: page.locator("#setup"),
          final: page.locator('section[aria-labelledby="final-cta-title"]'),
          footer: page.locator("footer"),
        };
        for (const [part, loc] of Object.entries(parts)) {
          await loc.screenshot({ path: `e2e/screenshots/windows-${vp.width}-${lang}-${part}.png` });
        }
      });
    }
  }
});
