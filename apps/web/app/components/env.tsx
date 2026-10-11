import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { pickAvail, type Avail } from "@/lib/content";
import { detectPlatform, isPlatform, osOfPlatform, type Platform } from "@/lib/platform";
import { WINDOWS_AVAILABLE, type Os } from "@/lib/site";

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
 * 未判定の間は、PC 版の配置では OS 中立のボタン、スマホ版の配置では「URL をコピー・共有」を出す
 */
function usePlatform(): Platform | null {
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

const noSubscribe = () => () => {};

/**
 * Windows 版を公開しているか (site.ts の WINDOWS_AVAILABLE)。開発時だけ ?windowsAvailable=1|0 で
 * 両方の表示を確かめられる。事前生成の HTML は定数で出し、ハイドレーション後に上書きを反映する
 */
function useWindowsAvailable(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => {
      if (import.meta.env.DEV) {
        const v = new URLSearchParams(window.location.search).get("windowsAvailable");
        if (v === "1") return true;
        if (v === "0") return false;
      }
      return WINDOWS_AVAILABLE;
    },
    () => WINDOWS_AVAILABLE,
  );
}

interface PageEnv {
  platform: Platform | null;
  /**
   * OS で切り替える部分 (セットアップの手順・キー表記・デモ) に出す OS。判定した OS を初期値にし、
   * セットアップのタブで利用者が選んだらそれを使う。判定前・Mac/Windows 以外は macOS
   */
  os: Os;
  setOs: (os: Os) => void;
  windowsAvailable: boolean;
}

const PageEnvContext = createContext<PageEnv | null>(null);

export function PageEnvProvider({ children }: { children: ReactNode }) {
  const platform = usePlatform();
  const windowsAvailable = useWindowsAvailable();
  const [chosen, setOs] = useState<Os | null>(null);
  const os = chosen ?? osOfPlatform(platform) ?? "macos";
  return (
    <PageEnvContext value={{ platform, os, setOs, windowsAvailable }}>{children}</PageEnvContext>
  );
}

export function usePageEnv(): PageEnv {
  const v = useContext(PageEnvContext);
  if (!v) throw new Error("PageEnvProvider の外で usePageEnv を呼んだ");
  return v;
}

/** Windows 版の公開状況で変わる文言を選ぶ */
export function useAvail() {
  const { windowsAvailable } = usePageEnv();
  return useCallback(<T,>(v: T | Avail<T>) => pickAvail(v, windowsAvailable), [windowsAvailable]);
}
