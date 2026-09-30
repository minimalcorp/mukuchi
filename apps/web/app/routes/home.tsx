import type { Route } from "./+types/home";
import {
  CtaNote,
  DownloadButton,
  PlatformList,
  ShareButtons,
  usePlatform,
  useShareActions,
  type ShareActions,
} from "@/components/cta";
import { Demo } from "@/components/demo";
import { ButtonLink, Icon } from "@/components/ui";
import {
  ALWAYS_ROWS,
  COMMANDS,
  FEATURES,
  PRIVACY,
  REQUIREMENT_ROWS,
  REQUIREMENTS_LEAD,
  SETUP_LEAD,
  STEPS,
  VAD_BARS,
  type Feature,
} from "@/lib/content";
import type { Platform } from "@/lib/platform";
import {
  COMPANY_NAME,
  COMPANY_URL,
  COPYRIGHT_PREFIX,
  DOWNLOAD_META,
  DOWNLOAD_META_SHORT,
  GITHUB_URL,
  SETUP_DURATION,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_TITLE,
  SITE_URL,
  VERSION,
} from "@/lib/site";

export function meta(): Route.MetaDescriptors {
  const image = `${SITE_URL}/og-image.jpg`;
  return [
    { title: SITE_TITLE },
    { name: "description", content: SITE_DESCRIPTION },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: SITE_NAME },
    { property: "og:locale", content: "ja_JP" },
    { property: "og:url", content: `${SITE_URL}/` },
    { property: "og:title", content: SITE_TITLE },
    { property: "og:description", content: SITE_DESCRIPTION },
    { property: "og:image", content: image },
    // 寸法を明示すると、初回共有時にクローラーが画像を取得し終える前でもプレビューを描画できる
    { property: "og:image:type", content: "image/jpeg" },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    {
      property: "og:image:alt",
      content: `${SITE_NAME} — Mac に常駐する音声入力アプリ`,
    },
    { name: "twitter:card", content: "summary_large_image" },
    { tagName: "link", rel: "canonical", href: `${SITE_URL}/` },
  ];
}

/**
 * スマホ版 (2a SP) を基本に、lg (1024px) 以上で PC 版 (1b LP) の配置にする。
 * デザインは PC 1280px・SP 390px の固定幅なので、中身の最大幅をそれぞれに合わせる
 */
const INNER = "mx-auto w-full max-w-[640px] lg:max-w-[1280px]";

const ICON_SRC = "/mukuchi-icon.png";

export default function Home() {
  const platform = usePlatform();
  const share = useShareActions();
  // 未判定の間は PC 版の配置では「判定不可の Mac」として出す (デザインの初期値と同じ)
  const pcPlatform: Platform = platform ?? "mac-unknown";
  // スマホ版の配置で URL のコピー・共有を出すのは、スマホと判定した時と未判定の間
  const spShare = platform === null || platform === "mobile";

  return (
    <>
      <Header platform={pcPlatform} />
      <main>
        <Hero platform={platform} pcPlatform={pcPlatform} spShare={spShare} share={share} />
        <Features />
        <Privacy />
        <SetupAndRequirements />
        <FinalCta pcPlatform={pcPlatform} spShare={spShare} share={share} />
      </main>
      <Footer />
    </>
  );
}

function Header({ platform }: { platform: Platform }) {
  return (
    <header className="border-b border-line-subtle">
      <div className={`${INNER} flex h-14 items-center gap-2.5 px-5 lg:h-16 lg:gap-6 lg:px-12`}>
        <a href="/" className="flex items-center gap-2.5 no-underline">
          <img src={ICON_SRC} alt="" width={36} height={36} className="size-8 lg:size-9" />
          <span className="text-[17px] font-semibold text-strong lg:text-[18px]">mukuchi</span>
        </a>
        <span className="flex-1" />
        <a href={GITHUB_URL} className="text-[14px] text-body hover:underline lg:hidden">
          GitHub
        </a>
        <nav aria-label="ページ内" className="hidden gap-6 text-[14px] lg:flex">
          <a href="#features" className="text-body hover:underline">
            特長
          </a>
          <a href="#privacy" className="text-body hover:underline">
            プライバシー
          </a>
          <a href="#setup" className="text-body hover:underline">
            セットアップ
          </a>
          <a href={GITHUB_URL} className="text-body hover:underline">
            GitHub
          </a>
        </nav>
        <div className="hidden lg:block">
          <DownloadButton platform={platform} size="sm" short />
        </div>
      </div>
    </header>
  );
}

function Hero({
  platform,
  pcPlatform,
  spShare,
  share,
}: {
  platform: Platform | null;
  pcPlatform: Platform;
  spShare: boolean;
  share: ShareActions;
}) {
  return (
    <section aria-labelledby="hero-title">
      <div
        className={`${INNER} lg:grid lg:grid-cols-2 lg:items-center lg:gap-12 lg:px-12 lg:pt-16 lg:pb-[72px] xl:grid-cols-[minmax(0,1fr)_600px]`}
      >
        <div className="flex flex-col gap-5 px-5 py-10 lg:gap-6 lg:p-0">
          <img
            src={ICON_SRC}
            alt=""
            width={120}
            height={120}
            className="-ml-2 size-24 lg:-ml-3 lg:size-[120px]"
          />
          <h1
            id="hero-title"
            className="m-0 text-[30px] leading-[1.3] font-semibold text-strong lg:text-[36px]"
          >
            話した言葉だけを、
            <br />
            そのまま入力。
          </h1>
          <p className="m-0 text-[15px] leading-[1.7] text-pretty text-body lg:text-[16px]">
            mukuchi は Mac
            に常駐する音声入力アプリです。マイクが拾った発話だけを検知して文字に起こし、前面のアプリへそのまま入力します。ホットキーを押す必要はありません。
          </p>

          {/* スマホ版の配置 */}
          <div className="lg:hidden" data-testid="hero-cta-sp">
            {spShare ? (
              <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-gray-50 p-4">
                <div className="flex items-start gap-2 text-[13px] leading-[1.6] text-body">
                  <Icon name="laptop" size={16} className="mt-0.5 text-muted" />
                  <span>
                    mukuchi は Mac 用のアプリです。Mac
                    のブラウザでこのページを開くと、ダウンロードできます。
                  </span>
                </div>
                <ShareButtons actions={share} />
                <div className="text-xs text-muted">{DOWNLOAD_META_SHORT}</div>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                <DownloadButton platform={pcPlatform} size="lg" className="w-full" />
                <div className="text-[13px] text-muted">{DOWNLOAD_META}</div>
                <CtaNote platform={pcPlatform} />
              </div>
            )}
          </div>

          {/* PC 版の配置 */}
          <div className="hidden flex-col gap-2.5 lg:flex" data-testid="hero-cta-pc">
            <div className="flex gap-2">
              <DownloadButton platform={pcPlatform} size="lg" />
              <ButtonLink
                variant="ghost"
                iconRight="external-link"
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub で見る
              </ButtonLink>
            </div>
            <div className="text-[13px] text-muted">{DOWNLOAD_META}</div>
            <CtaNote platform={pcPlatform} />
          </div>

          <PlatformList platform={platform} />
        </div>
        <div className="px-4 pb-10 lg:p-0">
          <Demo />
        </div>
      </div>
    </section>
  );
}

function Features() {
  return (
    <section id="features" aria-labelledby="features-title" className="border-t border-line-subtle">
      <div className={`${INNER} flex flex-col gap-10 px-5 py-12 lg:gap-14 lg:px-12 lg:py-20`}>
        <h2
          id="features-title"
          className="m-0 text-[24px] leading-[1.35] font-semibold text-strong lg:text-[30px] lg:leading-[1.3]"
        >
          操作しないで、入力する
        </h2>
        {FEATURES.map((f) => (
          <article
            key={f.no}
            className="flex flex-col gap-3.5 border-t border-line-subtle pt-6 lg:grid lg:grid-cols-[80px_minmax(0,1fr)_440px] lg:items-start lg:gap-8 lg:pt-8 xl:grid-cols-[80px_minmax(0,1fr)_520px]"
          >
            <span className="font-mono text-[24px] leading-none font-medium text-blue-500 lg:text-[30px]">
              {f.no}
            </span>
            <div className="contents lg:flex lg:flex-col lg:gap-3">
              <h3 className="m-0 text-[18px] leading-[1.4] font-semibold text-strong lg:text-[20px]">
                {f.title}
              </h3>
              <p className="m-0 text-[14px] leading-[1.7] text-pretty text-body lg:text-[15px]">
                {f.body}
              </p>
            </div>
            <div className="flex flex-col gap-2.5 rounded-lg border border-line-subtle bg-gray-50 p-4 lg:min-h-[140px] lg:justify-center lg:p-5">
              <FeatureVisual visual={f.visual} />
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function FeatureVisual({ visual }: { visual: Feature["visual"] }) {
  if (visual === "always") {
    return ALWAYS_ROWS.map((r) => (
      <div key={r.k} className="flex items-center gap-2.5 text-[13px]">
        <Icon name={r.icon} size={16} className="text-muted" />
        <span className="flex-1 text-body">{r.k}</span>
        <span className="font-semibold text-strong tabular-nums">{r.v}</span>
      </div>
    ));
  }
  if (visual === "vad") {
    return (
      <>
        <div className="flex h-10 items-center gap-px lg:h-12 lg:gap-0.5" aria-hidden="true">
          {VAD_BARS.map((b, i) => (
            <span
              key={i}
              className={`flex-1 rounded-[1px] ${b.speech ? "bg-blue-500" : "bg-gray-300"}`}
              style={{ height: `${b.h}%` }}
            />
          ))}
        </div>
        <div className="flex flex-col gap-1 text-xs text-muted lg:flex-row lg:gap-3">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[2px] bg-blue-500" />
            発話（文字起こしして入力）
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[2px] bg-gray-300" />
            無音・環境音（何もしない）
          </span>
        </div>
      </>
    );
  }
  return (
    <ul
      className="m-0 flex list-none flex-col gap-2.5 p-0 lg:grid lg:grid-cols-2 lg:gap-x-4 lg:gap-y-2.5"
      data-testid="voice-commands"
    >
      {COMMANDS.map((c) => (
        <li key={c.word} className="flex items-center gap-2 text-[13px]">
          <span className="w-24 font-medium text-strong lg:w-[84px]">「{c.word}」</span>
          <Icon name="arrow-right" size={14} className="text-subtle" />
          <kbd className="rounded-sm border border-line bg-white px-1.5 py-px font-mono text-xs text-strong">
            {c.key}
          </kbd>
        </li>
      ))}
    </ul>
  );
}

function Privacy() {
  return (
    <section
      id="privacy"
      aria-labelledby="privacy-title"
      className="border-t border-line-subtle bg-gray-50"
    >
      <div className={`${INNER} flex flex-col gap-6 px-5 py-12 lg:gap-8 lg:px-12 lg:py-[72px]`}>
        <div className="flex flex-col gap-2 lg:max-w-[640px]">
          <h2
            id="privacy-title"
            className="m-0 text-[24px] leading-[1.35] font-semibold text-strong lg:text-[30px] lg:leading-[1.3]"
          >
            音声は Mac の外に出ません
          </h2>
          <p className="m-0 text-[14px] leading-[1.7] text-body lg:text-[15px]">
            文字起こしはすべて端末内で処理します。社外秘の資料や顧客情報を扱う業務でも使えます。
          </p>
        </div>
        <ul className="m-0 flex list-none flex-col rounded-lg border border-line bg-white p-0 lg:grid lg:grid-cols-4 lg:gap-4 lg:rounded-none lg:border-0 lg:bg-transparent">
          {PRIVACY.map((p) => (
            <li
              key={p.title}
              className="grid grid-cols-[20px_minmax(0,1fr)] gap-3 border-b border-line-subtle px-4 py-3.5 last:border-b-0 lg:flex lg:flex-col lg:gap-2.5 lg:rounded-lg lg:border lg:border-line lg:bg-white lg:p-5 lg:last:border-b"
            >
              <Icon name={p.icon} size={20} className="text-blue-500" />
              <div className="flex flex-col gap-0.5 lg:contents">
                <span className="text-[14px] font-semibold text-strong lg:text-[15px]">
                  {p.title}
                </span>
                <span className="text-[13px] leading-[1.6] text-body lg:leading-[1.7]">
                  {p.body}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function SetupAndRequirements() {
  return (
    <section id="setup" aria-labelledby="setup-title" className="border-t border-line-subtle">
      <div
        className={`${INNER} flex flex-col gap-12 px-5 py-12 lg:grid lg:grid-cols-2 lg:px-12 lg:py-[72px]`}
      >
        <div className="flex flex-col gap-4 lg:gap-6">
          <div className="flex flex-col gap-1.5 lg:gap-2">
            <h2
              id="setup-title"
              className="m-0 text-[22px] leading-[1.35] font-semibold text-strong lg:text-[24px] lg:leading-[1.3]"
            >
              セットアップ
            </h2>
            <span className="text-[13px] text-muted lg:text-[14px]">{SETUP_LEAD}</span>
          </div>
          <ol className="m-0 flex list-none flex-col p-0">
            {STEPS.map((s) => (
              <li
                key={s.no}
                className="grid grid-cols-[28px_minmax(0,1fr)] gap-3.5 border-t border-line-subtle py-3.5 lg:gap-4 lg:py-4"
              >
                <span className="flex size-7 items-center justify-center rounded-full bg-gray-900 font-mono text-[13px] font-semibold text-white">
                  {s.no}
                </span>
                <div className="flex flex-col gap-1">
                  <span className="text-[15px] font-semibold text-strong">{s.title}</span>
                  <span className="text-[13px] leading-[1.7] text-body lg:text-[14px]">
                    {s.body}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <div id="requirements" className="flex flex-col gap-4 lg:gap-6">
          <div className="flex flex-col gap-1.5 lg:gap-2">
            <h2 className="m-0 text-[22px] leading-[1.35] font-semibold text-strong lg:text-[24px] lg:leading-[1.3]">
              動作要件
            </h2>
            <span className="text-[13px] leading-[1.6] text-muted lg:text-[14px]">
              {REQUIREMENTS_LEAD}
            </span>
          </div>
          <dl className="m-0 overflow-hidden rounded-lg border border-line">
            {REQUIREMENT_ROWS.map((r) => (
              <div
                key={r.k}
                className="grid grid-cols-[96px_minmax(0,1fr)] border-b border-line-subtle px-3.5 py-2.5 text-[13px] last:border-b-0 lg:grid-cols-[140px_minmax(0,1fr)] lg:px-4"
              >
                <dt className="text-muted">{r.k}</dt>
                <dd className="m-0 text-strong">
                  {r.v}
                  {r.sub && <span className="block text-xs text-muted">{r.sub}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}

function FinalCta({
  pcPlatform,
  spShare,
  share,
}: {
  pcPlatform: Platform;
  spShare: boolean;
  share: ShareActions;
}) {
  const pcLead = `無料で使えます。インストールから入力開始まで${SETUP_DURATION}です。`;
  return (
    <section aria-labelledby="final-cta-title">
      <div className={`${INNER} px-4 pb-12 lg:px-12 lg:pb-[72px]`}>
        <div className="flex flex-col items-center gap-3.5 rounded-xl border border-line bg-gray-50 px-5 py-7 text-center lg:grid lg:grid-cols-[120px_minmax(0,1fr)_auto] lg:gap-8 lg:px-12 lg:py-10 lg:text-left">
          <img
            src={ICON_SRC}
            alt=""
            width={120}
            height={120}
            loading="lazy"
            className="size-[88px] lg:size-[120px]"
          />
          <div className="contents lg:flex lg:flex-col lg:gap-2">
            <h2
              id="final-cta-title"
              className="m-0 text-[20px] leading-[1.4] font-semibold text-strong lg:text-[24px] lg:leading-[1.35]"
            >
              まずは常駐させて、
              <br className="lg:hidden" />
              一日使ってみてください
            </h2>
            <span className="text-[13px] leading-[1.6] text-body lg:hidden">
              {spShare
                ? "無料で使えます。Mac のブラウザでこのページを開き、ダウンロードしてください。"
                : pcLead}
            </span>
            <span className="hidden text-[14px] leading-[1.6] text-body lg:inline">{pcLead}</span>
            <div className="hidden lg:block">
              <CtaNote platform={pcPlatform} />
            </div>
          </div>
          <div className="contents lg:flex lg:flex-col lg:items-end lg:gap-2">
            <div className="w-full lg:hidden" data-testid="final-cta-sp">
              {spShare ? (
                <ShareButtons actions={share} />
              ) : (
                <DownloadButton platform={pcPlatform} size="lg" className="w-full" />
              )}
            </div>
            <div className="hidden lg:block" data-testid="final-cta-pc">
              <DownloadButton platform={pcPlatform} size="lg" />
            </div>
            <span className="text-xs text-muted lg:hidden">
              {spShare ? DOWNLOAD_META_SHORT : DOWNLOAD_META}
            </span>
            <span className="hidden text-xs text-muted lg:inline">{DOWNLOAD_META}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line-subtle">
      <div
        className={`${INNER} flex flex-col gap-1.5 p-5 text-xs text-muted lg:flex-row lg:items-center lg:gap-4 lg:px-12 lg:py-6 lg:text-[13px]`}
      >
        <div className="flex items-center gap-2 lg:contents">
          <img
            src={ICON_SRC}
            alt=""
            width={24}
            height={24}
            loading="lazy"
            className="size-5 lg:size-6"
          />
          <span>
            {SITE_NAME} {VERSION}
          </span>
          <span className="flex-1" />
          <a href={GITHUB_URL} className="text-muted hover:underline">
            GitHub
          </a>
        </div>
        <span>
          {COPYRIGHT_PREFIX}{" "}
          <a href={COMPANY_URL} className="text-muted hover:underline">
            {COMPANY_NAME}
          </a>
        </span>
      </div>
    </footer>
  );
}
