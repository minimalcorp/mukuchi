import { useCallback, useEffect, useState } from "react";
import { CTA, detectPlatform, isPlatform, type Platform } from "@/lib/platform";
import { DOWNLOAD_URL, SHARE_TEXT, SITE_NAME } from "@/lib/site";
import { Button, ButtonLink, Icon, Badge } from "./ui";

async function resolvePlatform(): Promise<Platform> {
  // 開発時だけ ?os=mac-intel などで各状態を確認できる (デザインの Tweaks の代わり。本番のビルドには含まれない)
  if (import.meta.env.DEV) {
    const forced = new URLSearchParams(window.location.search).get("os");
    if (isPlatform(forced)) return forced;
  }
  return detectPlatform(navigator);
}

/**
 * 閲覧中の環境。事前生成の HTML とハイドレーション直後は null (未判定)。
 * 未判定の間は、PC 版の配置では「判定不可の Mac」、スマホ版の配置では「URL をコピー・共有」を出す
 */
export function usePlatform(): Platform | null {
  const [platform, setPlatform] = useState<Platform | null>(null);
  useEffect(() => {
    let cancelled = false;
    resolvePlatform().then((p) => {
      if (!cancelled) setPlatform(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return platform;
}

/** このページの URL (クエリ・ハッシュは除く) をコピー・共有する */
export function useShareActions() {
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
      await navigator.share({ title: SITE_NAME, text: SHARE_TEXT, url: pageUrl() });
    } catch {
      // 共有シートを閉じた場合も reject されるので何もしない
    }
  }, [copy]);

  return { copied, copy, share };
}

export type ShareActions = ReturnType<typeof useShareActions>;

/** ダウンロードボタン (判定結果で文言・可否が変わる) */
export function DownloadButton({
  platform,
  size,
  short = false,
  className,
}: {
  platform: Platform;
  size: "sm" | "lg";
  short?: boolean;
  className?: string;
}) {
  const cta = CTA[platform];
  const label = short ? cta.short : cta.label;
  if (cta.kind === "download") {
    return (
      <ButtonLink
        variant="primary"
        size={size}
        iconLeft={cta.icon}
        href={DOWNLOAD_URL}
        className={className}
        data-cta="download"
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

export function CtaNote({ platform }: { platform: Platform }) {
  const cta = CTA[platform];
  return (
    <div
      className={`flex items-center gap-1.5 text-[13px] ${cta.noteTone === "success" ? "text-success" : "text-muted"}`}
      data-testid="cta-note"
    >
      <Icon name={cta.noteIcon} size={14} />
      {cta.note}
    </div>
  );
}

/** スマホ向け: ダウンロードの代わりに URL のコピーと共有 */
export function ShareButtons({ actions }: { actions: ShareActions }) {
  return (
    <div className="grid w-full grid-cols-2 gap-2">
      <Button
        variant="primary"
        iconLeft={actions.copied ? "check" : "link"}
        onClick={actions.copy}
        className="w-full min-w-0"
      >
        {actions.copied ? "コピーしました" : "URL をコピー"}
      </Button>
      <Button iconLeft="share" onClick={actions.share} className="w-full min-w-0">
        共有
      </Button>
    </div>
  );
}

/** 提供状況。PC 版の配置では閲覧中の OS の枠を濃くする (スマホ版のデザインでは強調しない) */
export function PlatformList({ platform }: { platform: Platform | null }) {
  const macOk = platform === "mac-arm" || platform === "mac-unknown";
  const items = [
    { name: "macOS（Apple Silicon）", available: true, current: macOk },
    { name: "Windows", available: false, current: platform === "windows" },
    { name: "Linux", available: false, current: platform === "linux" },
  ];
  return (
    <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
      {items.map((p) => (
        <li
          key={p.name}
          className={`flex h-8 items-center gap-2 rounded-md border border-line bg-white px-2.5 text-xs lg:px-3 lg:text-[13px] ${p.current ? "lg:border-line-strong" : ""}`}
        >
          <span className="font-medium text-strong">{p.name}</span>
          <Badge tone={p.available ? "success" : "neutral"}>
            {p.available ? "提供中" : "準備中"}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
