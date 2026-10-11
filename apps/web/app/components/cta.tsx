import { useCallback, useEffect, useState } from "react";
import { ctaState, type Platform } from "@/lib/platform";
import { track, type CtaLocation } from "@/lib/analytics";
import { useI18n } from "@/i18n/context";
import { DOWNLOADS, SITE_NAME, type Os } from "@/lib/site";
import { useAvail, usePageEnv } from "./env";
import { Button, ButtonLink, Icon, Badge } from "./ui";

/**
 * ダウンロードの計測。dmg・exe は GA の拡張計測機能の file_download の対象外の拡張子なので自分で送る。
 * platform は閲覧中の環境の判定結果 (別の OS の版を落としたかを見分ける。判定前は unknown)
 */
function trackDownload(os: Os, location: CtaLocation, platform: Platform | null) {
  const d = DOWNLOADS[os];
  track("file_download", {
    file_name: d.fileName,
    file_extension: d.ext,
    link_url: d.url,
    cta_location: location,
    platform: platform ?? "unknown",
  });
}

/** このページの URL (クエリ・ハッシュは除く) をコピー・共有する */
export function useShareActions() {
  const { m } = useI18n();
  const shareText = m.shareText;
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  const pageUrl = () => window.location.origin + window.location.pathname;

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(pageUrl());
      setCopied(true);
      track("share", { method: "copy" });
    } catch {
      // 非セキュアな接続・権限の拒否ではコピーできない。ボタンの表示は変えない
    }
  }, []);

  const share = useCallback(async () => {
    if (!navigator.share) {
      await copy();
      return;
    }
    try {
      await navigator.share({ title: SITE_NAME, text: shareText, url: pageUrl() });
      track("share", { method: "native" });
    } catch {
      // 共有シートを閉じた場合も reject されるので何もしない
    }
  }, [copy, shareText]);

  return { copied, copy, share };
}

export type ShareActions = ReturnType<typeof useShareActions>;

/** 判定結果に応じたボタンの状態 */
function useCta() {
  const { platform, windowsAvailable } = usePageEnv();
  return ctaState(platform, windowsAvailable);
}

/** ダウンロードボタン (判定結果で文言・可否・成果物が変わる) */
export function DownloadButton({
  location,
  size,
  short = false,
  className,
}: {
  /** 計測で、どこのボタンが押されたかを見分ける */
  location: CtaLocation;
  size: "sm" | "lg";
  short?: boolean;
  className?: string;
}) {
  const { m } = useI18n();
  const { platform } = usePageEnv();
  const avail = useAvail();
  const cta = useCta();
  const text = { ...(cta.os ? m.cta.download[cta.os] : {}), ...m.cta.states[cta.text] };
  const label = avail((short ? text.short : text.label) ?? "");
  if (cta.kind === "download" && cta.os) {
    const os = cta.os;
    return (
      <ButtonLink
        variant="primary"
        size={size}
        iconLeft={cta.icon}
        href={DOWNLOADS[os].url}
        className={className}
        data-cta="download"
        data-os={os}
        onClick={() => trackDownload(os, location, platform)}
      >
        {label}
      </ButtonLink>
    );
  }
  if (cta.kind === "pending") {
    // 判定前 (事前生成の HTML・JS なし)。動作要件の表の両 OS のダウンロードへ移る
    return (
      <ButtonLink
        variant="primary"
        size={size}
        iconLeft={cta.icon}
        href="#requirements"
        className={className}
        data-cta="pending"
      >
        {label}
      </ButtonLink>
    );
  }
  return (
    <Button
      variant="primary"
      size={size}
      iconLeft={cta.icon}
      disabled
      className={className}
      data-cta="unavailable"
    >
      {label}
    </Button>
  );
}

export function CtaNote() {
  const { m } = useI18n();
  const avail = useAvail();
  const cta = useCta();
  return (
    <div
      className={`flex items-start gap-1.5 text-[13px] leading-[1.6] ${cta.noteTone === "success" ? "text-success" : "text-muted"}`}
      data-testid="cta-note"
    >
      <Icon name={cta.noteIcon} size={14} className="mt-[3px]" />
      <span>{avail(m.cta.states[cta.text].note)}</span>
    </div>
  );
}

/** ボタンの下の補足 (版・価格・対応・サイズ)。ボタンの OS の値、判定できない時は OS 中立の値 */
export function DownloadMeta({ className }: { className?: string }) {
  const { m } = useI18n();
  const avail = useAvail();
  const cta = useCta();
  return (
    <div className={className} data-testid="download-meta">
      {cta.meta ? m.downloadMeta[cta.meta] : avail(m.downloadMeta.any)}
    </div>
  );
}

/**
 * ボタンの下の補助: ほかの OS 版へのリンク (別の PC で使う人向け) と、この端末で使えない環境 (Linux など) の
 * URL のコピー・共有。どちらも無ければ何も出さない
 */
export function CtaExtras({ share, location }: { share: ShareActions; location: CtaLocation }) {
  const cta = useCta();
  if (cta.alt.length === 0 && !cta.share) return null;
  return (
    <div className="flex flex-col gap-2.5">
      <AltLinks oses={cta.alt} location={location} />
      {cta.share && (
        <div className="lg:max-w-[360px]">
          <ShareButtons actions={share} />
        </div>
      )}
    </div>
  );
}

function AltLinks({ oses, location }: { oses: Os[]; location: CtaLocation }) {
  const { m } = useI18n();
  const { platform } = usePageEnv();
  if (oses.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted"
      data-testid="cta-alt"
    >
      <span>{m.cta.alt.label}</span>
      {oses.map((os) => (
        <a
          key={os}
          href={DOWNLOADS[os].url}
          data-os={os}
          onClick={() => trackDownload(os, location, platform)}
          className="flex items-center gap-1 text-body underline-offset-2 hover:underline"
        >
          <Icon name="download" size={14} className="text-muted" />
          {m.cta.alt.links[os]}
        </a>
      ))}
    </div>
  );
}

/** 動作要件の表の、その OS のダウンロード。公開前の Windows は「準備中」のバッジにする */
export function OsDownloadLink({ os }: { os: Os }) {
  const { m } = useI18n();
  const { platform, windowsAvailable } = usePageEnv();
  if (os === "windows" && !windowsAvailable) {
    return <Badge tone="neutral">{m.requirements.comingSoon}</Badge>;
  }
  return (
    <a
      href={DOWNLOADS[os].url}
      data-os={os}
      data-testid="requirements-download"
      onClick={() => trackDownload(os, "requirements", platform)}
      className="flex items-center gap-1 text-[13px] text-body underline underline-offset-2"
    >
      <Icon name="download" size={14} className="text-muted" />
      {m.requirements.download[os]}
    </a>
  );
}

/** スマホ向け: ダウンロードの代わりに URL のコピーと共有 */
export function ShareButtons({ actions }: { actions: ShareActions }) {
  const { m } = useI18n();
  return (
    <div className="grid w-full grid-cols-2 gap-2">
      <Button
        variant="primary"
        iconLeft={actions.copied ? "check" : "link"}
        onClick={actions.copy}
        className="w-full min-w-0"
      >
        {actions.copied ? m.cta.copied : m.cta.copyUrl}
      </Button>
      <Button iconLeft="share" onClick={actions.share} className="w-full min-w-0">
        {m.cta.share}
      </Button>
    </div>
  );
}

/** 提供状況。PC 版の配置では閲覧中の OS の枠を濃くする (スマホ版のデザインでは強調しない) */
export function PlatformList() {
  const { m } = useI18n();
  const { platform, windowsAvailable } = usePageEnv();
  const p = m.cta.platforms;
  const items = [
    {
      name: p.macos,
      badge: p.available,
      available: true,
      current: platform === "mac-arm" || platform === "mac-unknown",
    },
    {
      name: p.windows,
      badge: windowsAvailable ? p.available : p.comingSoon,
      available: windowsAvailable,
      current: platform === "windows-x64" || platform === "windows-arm",
    },
    { name: "Linux", badge: p.planned, available: false, current: platform === "linux" },
  ];
  return (
    <ul className="m-0 flex list-none flex-wrap gap-2 p-0" data-testid="platform-list">
      {items.map((it) => (
        <li
          key={it.name}
          className={`flex h-8 items-center gap-2 rounded-md border border-line bg-white px-2.5 text-xs lg:px-3 lg:text-[13px] ${it.current ? "lg:border-line-strong" : ""}`}
        >
          <span className="font-medium text-strong">{it.name}</span>
          <Badge tone={it.available ? "success" : "neutral"}>{it.badge}</Badge>
        </li>
      ))}
    </ul>
  );
}
