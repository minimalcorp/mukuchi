import { expect, test, type Page } from "@playwright/test";
import { en } from "../app/i18n/en";
import { ja, type Messages } from "../app/i18n/ja";
import { COMPANY_URL, DOWNLOAD_URL, SITE_URL, googlePartnerSitesUrl } from "../app/lib/site";

// 日本語のページの確認はブラウザの言語を日本語にする (日本語以外だと英語のページの案内が出る)
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

const scriptMs = (m: Messages, mode: keyof Messages["demo"]["scripts"]) =>
  m.demo.scripts[mode].reduce((sum, st) => sum + st.ms, 0);
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
    modeMeta.always.appName,
    modeMeta.once.appName,
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

    const reqs = page.locator("#requirements dl");
    await expect(reqs).toContainText("macOS 13 Ventura 以降");
    await expect(reqs).toContainText("空き容量 6 GB 以上");
    await expect(reqs).toContainText("動作確認M1 Max・M3 Pro");
    await expect(reqs).toContainText("Qwen3-ASR 1.7B（日本語・約 2.2 GB）");
    await expect(page.getByText("Qwen3-ASR 1.7B（約 2.2 GB）をダウンロードします。")).toBeVisible();
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
    const steps = page.locator("#setup ol > li");
    await expect(steps).toHaveCount(5);
    expect(ja.setup.steps).toHaveLength(5);
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
    await expect(page.locator(`a[href="${DOWNLOAD_URL}"]`)).toHaveCount(0);
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
    const reqs = page.locator("#requirements dl");
    await expect(reqs).toContainText("macOS 13 Ventura or later");
    await expect(reqs).toContainText("Speech modelQwen3-ASR 1.7B (about 2.2 GB)");
    await expect(reqs).toContainText("English and Japanese");
    await expect(page.locator("#setup ol > li")).toHaveCount(5);
    await expect(heroPc(page).getByRole("link", { name: "Download for Mac" })).toHaveAttribute(
      "href",
      DOWNLOAD_URL,
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
    // 英語のページに日本語の案内は出さない
    await expect(page.getByTestId("english-notice")).toHaveCount(0);
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

test.describe("英語のページの案内", () => {
  test.use({ viewport: PC, locale: "en-US" });

  test("日本語以外のブラウザで `/` を開くと案内を出し、閉じると次から出さない", async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await fakeNavigator(page, ENVS.macArm);
    await page.goto("/");
    const notice = page.getByTestId("english-notice");
    await expect(notice).toBeVisible();
    await expect(notice.getByRole("link")).toHaveText("This page is also available in English →");
    await expect(notice.getByRole("link")).toHaveAttribute("href", "/en/");
    // 自動では移動しない
    await expect(page).toHaveURL((u) => u.pathname === "/");
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");

    await notice.getByRole("button", { name: "Close" }).click();
    await expect(notice).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("cta-note").first()).toHaveText(/検出しました/);
    await expect(page.getByTestId("english-notice")).toHaveCount(0);
    // 事前生成の HTML (案内なし) とハイドレーションが食い違わない
    expect(errors).toEqual([]);
  });

  test("案内のリンクで英語のページへ移動する", async ({ page }) => {
    await page.goto("/");
    await page.getByTestId("english-notice").getByRole("link").click();
    await expect(page).toHaveURL(/\/en\/$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });

  test("localStorage が使えなくても案内を出し、閉じられる", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new DOMException("denied", "SecurityError");
        },
      });
    });
    await page.goto("/");
    const notice = page.getByTestId("english-notice");
    await expect(notice).toBeVisible();
    await notice.getByRole("button", { name: "Close" }).click();
    await expect(notice).toHaveCount(0);
  });
});

test("日本語のブラウザでは英語のページの案内を出さない", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByTestId("cta-note").first()).toBeVisible();
  await expect(page.getByTestId("english-notice")).toHaveCount(0);
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

  test("スクリーンショット 英語のページの案内 (390px)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await fakeNavigator(page, ENVS.iphone);
    await page.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "languages", {
        get: () => ["en-US", "en"],
        configurable: true,
      });
    });
    await page.goto("/");
    await expect(page.getByTestId("english-notice")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: "e2e/screenshots/sp-390-english-notice.png" });
  });
});
