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
import { track, type CtaLocation } from "@/lib/analytics";
import { Badge, ButtonLink, Icon, Keycap } from "@/components/ui";
import {
  DEFAULT_MODE,
  INPUT_MODES,
  MODE_BARS,
  MODE_ICONS,
  VAD_BARS,
  type Feature,
  type InputMode,
} from "@/lib/content";
import { useI18n } from "@/i18n/context";
import { LOCALES, LOCALE_NAMES, LOCALE_PATHS, type Locale } from "@/i18n/locales";
import { rememberLocaleChoice } from "@/i18n/redirect";
import type { Platform } from "@/lib/platform";
import {
  COMPANY_URL,
  COPYRIGHT_PREFIX,
  GITHUB_URL,
  SHORTCUT_KEYS,
  SITE_NAME,
  VERSION,
  googlePartnerSitesUrl,
} from "@/lib/site";

/**
 * スマホ版 (1b SP) を基本に、lg (1024px) 以上で PC 版 (1a PC) の配置にする。
 * デザインは PC 1280px・SP 390px の固定幅なので、中身の最大幅をそれぞれに合わせる
 */
const INNER = "mx-auto w-full max-w-[640px] lg:max-w-[1280px]";

const ICON_SRC = "/mukuchi-icon.png";

const trackGithub = (location: CtaLocation) => () =>
  track("github_click", { cta_location: location });

/** LP の本体。言語ごとのルート (routes/home.tsx・routes/home.en.tsx) が辞書を渡して描く */
export function HomePage() {
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
        <Modes />
        <Features />
        <Privacy />
        <SetupAndRequirements />
        <FinalCta pcPlatform={pcPlatform} spShare={spShare} share={share} />
      </main>
      <Footer />
    </>
  );
}

/** 言語の切り替え (ヘッダー右上とフッター)。各言語の自称で並べ、今の言語は文字だけにする */
function LanguageSwitch({
  className,
  iconClassName,
}: {
  className?: string;
  iconClassName?: string;
}) {
  const { locale, m } = useI18n();
  return (
    <nav
      aria-label={m.nav.language}
      data-testid="language-switch"
      className={`flex items-center gap-1.5 whitespace-nowrap ${className ?? ""}`}
    >
      <Icon name="languages" size={14} className={`text-muted ${iconClassName ?? ""}`} />
      {LOCALES.map((l: Locale, i) => (
        <span key={l} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-subtle">/</span>}
          {l === locale ? (
            <span aria-current="page" lang={l} className="font-semibold text-strong">
              {LOCALE_NAMES[l]}
            </span>
          ) : (
            <a
              href={LOCALE_PATHS[l]}
              hrefLang={l}
              lang={l}
              onClick={() => rememberLocaleChoice(l)}
              className="text-body hover:underline"
            >
              {LOCALE_NAMES[l]}
            </a>
          )}
        </span>
      ))}
    </nav>
  );
}

function Header({ platform }: { platform: Platform }) {
  const { locale, m } = useI18n();
  return (
    <header className="border-b border-line-subtle">
      <div className={`${INNER} flex h-14 items-center gap-3 px-5 lg:h-16 lg:gap-6 lg:px-12`}>
        <a href={LOCALE_PATHS[locale]} className="flex flex-none items-center gap-2.5 no-underline">
          <img src={ICON_SRC} alt="" width={36} height={36} className="size-8 lg:size-9" />
          <span className="text-[17px] font-semibold text-strong lg:text-[18px]">mukuchi</span>
        </a>
        <span className="flex-1" />
        <a
          href={GITHUB_URL}
          onClick={trackGithub("header")}
          // 幅の狭いスマホ (360px 未満) では言語の切り替えと並ばないので出さない (フッターにもある)
          className="text-[14px] text-body hover:underline max-[359px]:hidden lg:hidden"
        >
          GitHub
        </a>
        <nav aria-label={m.nav.label} className="hidden gap-6 text-[14px] lg:flex">
          <a href="#modes" className="text-body hover:underline">
            {m.nav.modes}
          </a>
          <a href="#features" className="text-body hover:underline">
            {m.nav.features}
          </a>
          <a href="#privacy" className="text-body hover:underline">
            {m.nav.privacy}
          </a>
          <a href="#setup" className="text-body hover:underline">
            {m.nav.setup}
          </a>
          <a
            href={GITHUB_URL}
            onClick={trackGithub("header")}
            className="text-body hover:underline"
          >
            GitHub
          </a>
        </nav>
        <LanguageSwitch className="text-[13px] lg:text-[14px]" iconClassName="max-[389px]:hidden" />
        <div className="hidden lg:block">
          <DownloadButton platform={platform} location="header" size="sm" short />
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
  const { m } = useI18n();
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
            {m.hero.title[0]}
            <br />
            {m.hero.title[1]}
          </h1>
          {/* スマホ版は本文と補足の行を他の要素と同じ間隔で、PC 版は 1 つのまとまりとして詰めて並べる */}
          <div className="flex flex-col gap-5 lg:gap-3">
            <p className="m-0 text-[15px] leading-[1.7] text-pretty text-body lg:text-[16px]">
              {m.hero.body}
            </p>
            {/* 幅の狭い画面では文の途中で自然に折り返すよう、キーキャップは文中に置く */}
            <p className="m-0 text-[14px] leading-[1.7] text-body">
              {m.hero.once.before}
              <span className="mx-1.5 lg:mx-2">
                <Keycap keys={SHORTCUT_KEYS} />
              </span>
              {m.hero.once.after}
            </p>
          </div>

          {/* スマホ版の配置 */}
          <div className="lg:hidden" data-testid="hero-cta-sp">
            {spShare ? (
              <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-gray-50 p-4">
                <div className="flex items-start gap-2 text-[13px] leading-[1.6] text-body">
                  <Icon name="laptop" size={16} className="mt-0.5 text-muted" />
                  <span>{m.hero.macOnly}</span>
                </div>
                <ShareButtons actions={share} />
                <div className="text-xs text-muted">{m.downloadMetaShort}</div>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                <DownloadButton
                  platform={pcPlatform}
                  location="hero"
                  size="lg"
                  className="w-full"
                />
                <div className="text-[13px] text-muted">{m.downloadMeta}</div>
                <CtaNote platform={pcPlatform} />
              </div>
            )}
          </div>

          {/* PC 版の配置 */}
          <div className="hidden flex-col gap-2.5 lg:flex" data-testid="hero-cta-pc">
            <div className="flex gap-2">
              <DownloadButton platform={pcPlatform} location="hero" size="lg" />
              <ButtonLink
                variant="ghost"
                iconRight="external-link"
                href={GITHUB_URL}
                onClick={trackGithub("hero")}
                target="_blank"
                rel="noopener noreferrer"
              >
                {m.hero.github}
              </ButtonLink>
            </div>
            <div className="text-[13px] text-muted">{m.downloadMeta}</div>
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

function Modes() {
  const { m } = useI18n();
  return (
    <section id="modes" aria-labelledby="modes-title" className="border-t border-line-subtle">
      <div className={`${INNER} flex flex-col gap-6 px-5 py-12 lg:gap-10 lg:px-12 lg:py-20`}>
        <div className="flex flex-col gap-2.5 lg:max-w-[720px] lg:gap-3">
          <h2
            id="modes-title"
            className="m-0 text-[24px] leading-[1.35] font-semibold text-strong lg:text-[30px] lg:leading-[1.3]"
          >
            {m.modes.title.lead}
            <br className="lg:hidden" />
            {m.modes.title.rest}
          </h2>
          <p className="m-0 text-[14px] leading-[1.7] text-pretty text-body lg:text-[15px]">
            {m.modes.lead}
          </p>
        </div>
        <div className="flex flex-col gap-6 lg:grid lg:grid-cols-2">
          {INPUT_MODES.map((mode) => (
            <ModeCardView key={mode} mode={mode} />
          ))}
        </div>
        <ShortcutCallout />
      </div>
    </section>
  );
}

function ModeCardView({ mode }: { mode: InputMode }) {
  const { m } = useI18n();
  const card = m.modes.cards[mode];
  return (
    <article
      data-testid={`mode-${mode}`}
      className="flex flex-col gap-4 rounded-lg border border-line px-4 py-5 lg:gap-5 lg:p-7"
    >
      <div className="flex flex-col gap-1.5 lg:gap-2">
        <div className="flex items-center gap-2 lg:gap-2.5">
          <Icon name={MODE_ICONS[mode]} size={20} className="text-blue-500" />
          <h3 className="m-0 text-[18px] font-semibold text-strong lg:text-[20px]">
            {m.modes.names[mode]}
          </h3>
          {mode === DEFAULT_MODE && <Badge tone="neutral">{m.modes.defaultBadge}</Badge>}
        </div>
        <p className="m-0 text-[14px] leading-[1.7] text-pretty text-body lg:text-[15px]">
          {card.body}
        </p>
      </div>

      {/* 波形。聞き取る区間の背景を塗り、その下に区間の説明を置く */}
      <div className="flex flex-col gap-2 rounded-lg border border-line-subtle bg-gray-50 px-3 pt-3 pb-2.5 lg:px-4 lg:pt-4 lg:pb-3">
        <div className="flex h-11 items-end gap-px lg:h-14 lg:gap-0.5" aria-hidden="true">
          {MODE_BARS[mode].map((b, i) => (
            <span
              key={i}
              className={`flex h-full flex-1 items-center ${b.band ? "bg-blue-50" : "bg-transparent"}`}
            >
              <span
                className={`w-full rounded-[1px] ${b.speech ? "bg-blue-500" : "bg-gray-300"}`}
                style={{ height: `${b.h}%` }}
              />
            </span>
          ))}
        </div>
        <div className="flex gap-0.5 text-[11px] leading-[1.4] lg:text-xs">
          {card.segs.map((seg) => (
            <span
              key={seg.t}
              className={`min-w-0 border-t-2 pt-1 lg:pt-1.5 ${seg.active ? "border-blue-500 text-strong" : "border-gray-300 text-muted"}`}
              style={{ flex: seg.f }}
            >
              <span className="lg:hidden">{seg.tSp}</span>
              <span className="hidden lg:inline">{seg.t}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-muted lg:text-[13px]">{m.modes.whenLabel}</span>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {card.when.map((w) => (
            <li
              key={w}
              className="flex items-start gap-2 text-[13px] leading-[1.6] text-strong lg:items-center lg:text-[14px]"
            >
              <Icon name="check" size={16} className="mt-0.5 text-success lg:mt-0" />
              {w}
            </li>
          ))}
        </ul>
      </div>

      <dl className="m-0 flex flex-col gap-2.5 border-t border-line-subtle pt-3.5 lg:gap-2 lg:pt-4">
        {card.keys.map((k) => (
          <div
            key={k.does}
            className="flex flex-col gap-0.5 text-[13px] lg:grid lg:grid-cols-[200px_minmax(0,1fr)] lg:items-center lg:gap-3"
          >
            <dt className="flex items-center gap-1.5 text-muted">
              <Keycap keys={SHORTCUT_KEYS} size="sm" />
              {k.when}
            </dt>
            <dd className="m-0 leading-[1.6] text-strong">{k.does}</dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

/** ⌥Space の説明。キーキャップは大きく 1 キーずつ描く (修飾キーは正方形、Space は横長) */
function ShortcutCallout() {
  const { m } = useI18n();
  const [mod, key] = SHORTCUT_KEYS;
  const cap =
    "flex h-10 items-center justify-center rounded-md border border-b-[3px] border-line-strong bg-white font-mono font-medium text-strong lg:h-11";
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-gray-50 px-4 py-5 lg:grid lg:grid-cols-[auto_minmax(0,1fr)] lg:items-center lg:gap-7 lg:px-7 lg:py-6">
      <div className="flex gap-1.5" aria-hidden="true">
        <span className={`${cap} w-11 text-[18px] lg:w-12 lg:text-[20px]`}>{mod}</span>
        <span className={`${cap} w-[120px] text-[15px] lg:w-[132px] lg:text-[16px]`}>{key}</span>
      </div>
      <div className="flex flex-col gap-3 lg:gap-1">
        <h3 className="m-0 text-[15px] leading-[1.5] font-semibold text-strong lg:text-[16px]">
          {m.modes.shortcut.title}
        </h3>
        <p className="m-0 text-[13px] leading-[1.7] text-body lg:text-[14px]">
          {m.modes.shortcut.body}
        </p>
      </div>
    </div>
  );
}

function Features() {
  const { m } = useI18n();
  return (
    <section id="features" aria-labelledby="features-title" className="border-t border-line-subtle">
      <div className={`${INNER} flex flex-col gap-10 px-5 py-12 lg:gap-14 lg:px-12 lg:py-20`}>
        <h2
          id="features-title"
          className="m-0 text-[24px] leading-[1.35] font-semibold text-strong lg:text-[30px] lg:leading-[1.3]"
        >
          {m.features.title}
        </h2>
        {m.features.items.map((f) => (
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
        <div className="flex flex-col gap-3 border-t border-line-subtle pt-6 lg:gap-5 lg:pt-8">
          <h3 className="m-0 text-[16px] font-semibold text-strong">{m.features.extrasTitle}</h3>
          <ul className="m-0 flex list-none flex-col p-0 lg:grid lg:grid-cols-3 lg:gap-4">
            {m.features.extras.map((e) => (
              <li
                key={e.title}
                className="grid grid-cols-[20px_minmax(0,1fr)] gap-3 border-b border-line-subtle py-3.5 lg:flex lg:flex-col lg:gap-2 lg:rounded-lg lg:border lg:border-line lg:p-5"
              >
                <Icon name={e.icon} size={20} className="text-muted" />
                <div className="flex flex-col gap-0.5 lg:contents">
                  <span className="text-[14px] font-semibold text-strong lg:text-[15px]">
                    {e.title}
                  </span>
                  <span className="text-[13px] leading-[1.6] text-body lg:leading-[1.7]">
                    {e.body}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function FeatureVisual({ visual }: { visual: Feature["visual"] }) {
  const { m } = useI18n();
  if (visual === "always") {
    return m.features.alwaysRows.map((r) => (
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
            {m.features.vadLegend.speech}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[2px] bg-gray-300" />
            {m.features.vadLegend.silence}
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
      {m.features.commands.map((c) => (
        <li key={c.word} className="flex items-center gap-2 text-[13px]">
          <span className="w-24 font-medium text-strong lg:w-[84px]">
            {m.features.quote(c.word)}
          </span>
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
  const { m } = useI18n();
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
            {m.privacy.title}
          </h2>
          <p className="m-0 text-[14px] leading-[1.7] text-body lg:text-[15px]">{m.privacy.lead}</p>
        </div>
        <ul className="m-0 flex list-none flex-col rounded-lg border border-line bg-white p-0 lg:grid lg:grid-cols-4 lg:gap-4 lg:rounded-none lg:border-0 lg:bg-transparent">
          {m.privacy.items.map((p) => (
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
  const { m } = useI18n();
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
              {m.setup.title}
            </h2>
            <span className="text-[13px] text-muted lg:text-[14px]">{m.setup.lead}</span>
          </div>
          <ol className="m-0 flex list-none flex-col p-0">
            {m.setup.steps.map((s) => (
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
              {m.requirements.title}
            </h2>
            <span className="text-[13px] leading-[1.6] text-muted lg:text-[14px]">
              {m.requirements.lead}
            </span>
          </div>
          <dl className="m-0 overflow-hidden rounded-lg border border-line">
            {m.requirements.rows.map((r) => (
              <div
                key={r.k}
                className="grid grid-cols-[96px_minmax(0,1fr)] border-b border-line-subtle px-3.5 py-2.5 text-[13px] last:border-b-0 lg:grid-cols-[140px_minmax(0,1fr)] lg:px-4"
              >
                <dt className="text-muted">{r.k}</dt>
                <dd className="m-0 text-strong">{r.v}</dd>
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
  const { m } = useI18n();
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
              {m.finalCta.title.lead}
              <br className="lg:hidden" />
              {m.finalCta.title.rest}
            </h2>
            <span className="text-[13px] leading-[1.6] text-body lg:hidden">
              {spShare ? m.finalCta.leadMobile : m.finalCta.lead}
            </span>
            <span className="hidden text-[14px] leading-[1.6] text-body lg:inline">
              {m.finalCta.lead}
            </span>
            <div className="hidden lg:block">
              <CtaNote platform={pcPlatform} />
            </div>
          </div>
          <div className="contents lg:flex lg:flex-col lg:items-end lg:gap-2">
            <div className="w-full lg:hidden" data-testid="final-cta-sp">
              {spShare ? (
                <ShareButtons actions={share} />
              ) : (
                <DownloadButton
                  platform={pcPlatform}
                  location="final"
                  size="lg"
                  className="w-full"
                />
              )}
            </div>
            <div className="hidden lg:block" data-testid="final-cta-pc">
              <DownloadButton platform={pcPlatform} location="final" size="lg" />
            </div>
            <span className="text-xs text-muted lg:hidden">
              {spShare ? m.downloadMetaShort : m.downloadMeta}
            </span>
            <span className="hidden text-xs text-muted lg:inline">{m.downloadMeta}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  const { locale, m } = useI18n();
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
          <LanguageSwitch />
          <a
            href={GITHUB_URL}
            onClick={trackGithub("footer")}
            className="text-muted hover:underline"
          >
            GitHub
          </a>
        </div>
        <span>
          {COPYRIGHT_PREFIX}{" "}
          <a href={COMPANY_URL} className="text-muted hover:underline">
            {m.footer.company}
          </a>
        </span>
      </div>
      {/* 電気通信事業法の外部送信規律の公表として、送信先と Google による使用の説明を示す */}
      <p
        className={`${INNER} m-0 -mt-3 px-5 pb-5 text-xs leading-[1.6] text-muted lg:-mt-4 lg:px-12 lg:pb-6`}
        data-testid="analytics-notice"
      >
        {m.footer.analytics}
        <a
          href={googlePartnerSitesUrl(locale)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted underline"
        >
          {m.footer.analyticsLink}
        </a>
      </p>
    </footer>
  );
}
