// 閲覧中の OS・CPU の判定。ボタンの出し分けはデザイン (1b LP の ctaMap) に Windows を足したもの
// (docs/plans/windows-plan.md §10.2)
import type { Os } from "./site";

export const PLATFORMS = [
  "mac-arm",
  "mac-unknown",
  "mac-intel",
  "windows-x64",
  "windows-arm",
  "linux",
  "mobile",
  "other",
] as const;
export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
}

/** 判定結果の OS (タブの初期選択に使う)。Mac・Windows 以外は null */
export function osOfPlatform(p: Platform | null): Os | null {
  if (p === "mac-arm" || p === "mac-unknown" || p === "mac-intel") return "macos";
  if (p === "windows-x64" || p === "windows-arm") return "windows";
  return null;
}

// User-Agent Client Hints は lib.dom に型がない (Chromium 系のみ実装)
interface UADataLike {
  platform?: string;
  mobile?: boolean;
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
}

export interface NavigatorLike {
  userAgent: string;
  platform?: string;
  maxTouchPoints?: number;
  userAgentData?: UADataLike;
}

/** CPU の種類 (UA-CH の architecture)。取れない・拒否された時は null */
async function architecture(uad: UADataLike | undefined): Promise<string | null> {
  try {
    if (uad?.getHighEntropyValues) {
      const v = await uad.getHighEntropyValues(["architecture"]);
      return v.architecture ?? null;
    }
  } catch {
    // 取得を拒否された場合は判定不可として扱う
  }
  return null;
}

/**
 * CPU の種類を取れるのは Chrome・Edge (UA-CH の architecture) だけ。
 * Safari・Firefox は Apple Silicon と Intel を区別できないので mac-unknown (ダウンロード可・Intel 非対応の注記) にする。
 * Windows の Firefox も x64 と ARM を区別できないので、利用者の多い x64 とみなす (ボタンの注記に x64 用と書く)。
 * デザインの WebGL のレンダラー名による推定は、Firefox が名前を丸めて返すなど確度が低く、
 * 誤って Intel と判定するとダウンロードできなくなるため使わない
 */
export async function detectPlatform(nav: NavigatorLike): Promise<Platform> {
  const ua = nav.userAgent || "";
  const uad = nav.userAgentData;
  const plat = (uad?.platform || nav.platform || "").toLowerCase();
  // iPadOS の Safari は Mac の UA を名乗るので、タッチ点数で見分ける
  const touchMac = /Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1;
  if (/iPhone|iPad|iPod|Android/.test(ua) || touchMac || uad?.mobile) return "mobile";
  if (/mac/.test(plat) || /Macintosh/.test(ua)) {
    const arch = await architecture(uad);
    if (arch === "arm") return "mac-arm";
    if (arch === "x86") return "mac-intel";
    return "mac-unknown";
  }
  if (/win/.test(plat)) {
    return (await architecture(uad)) === "arm" ? "windows-arm" : "windows-x64";
  }
  if (/linux/.test(plat) && !/Android/.test(ua)) return "linux";
  return "other";
}

/**
 * ボタンの出し分け (文言は辞書の cta.states[text])。
 * - kind: download = os の成果物へのリンク、unavailable = 無効なボタン、pending = 判定前 (事前生成の HTML。動作要件の
 *   両 OS のダウンロードへ移る OS 中立のボタン)
 * - meta: ボタンの下の補足 (版・価格・サイズ) をどの OS の値で出すか。null は OS 中立
 * - alt: 補助リンクで出す、ほかの OS のダウンロード (別の PC で使う人向け)
 * - share: URL のコピー・共有を出す (この端末では使えない環境から、使う PC へ URL を渡す)
 */
export interface CtaState {
  kind: "download" | "unavailable" | "pending";
  os: Os | null;
  text: CtaTextKey;
  icon: "download" | "ban" | "clock" | "laptop" | "monitor";
  noteIcon: "circle-check" | "info";
  noteTone: "success" | "muted";
  meta: Os | null;
  alt: Os[];
  share: boolean;
}

/** 辞書の cta.states のキー。Windows 版の公開前は Windows の判定結果を windows-soon にまとめる */
export type CtaTextKey = Platform | "pending" | "windows-soon";

const INFO = { noteIcon: "info", noteTone: "muted" } as const;

export function ctaState(platform: Platform | null, windowsAvailable: boolean): CtaState {
  const win: Os[] = windowsAvailable ? ["windows"] : [];
  const base = { os: null, meta: null, alt: [], share: false, ...INFO };
  switch (platform) {
    case null:
      return { ...base, kind: "pending", text: "pending", icon: "download" };
    case "mac-arm":
      return {
        ...base,
        kind: "download",
        os: "macos",
        text: platform,
        icon: "download",
        noteIcon: "circle-check",
        noteTone: "success",
        meta: "macos",
        alt: win,
      };
    case "mac-unknown":
      return {
        ...base,
        kind: "download",
        os: "macos",
        text: platform,
        icon: "download",
        meta: "macos",
        alt: win,
      };
    case "mac-intel":
      return { ...base, kind: "unavailable", text: platform, icon: "ban", meta: "macos", alt: win };
    case "windows-x64":
    case "windows-arm":
      if (!windowsAvailable) {
        return {
          ...base,
          kind: "unavailable",
          text: "windows-soon",
          icon: "clock",
          meta: "macos",
          alt: ["macos"],
        };
      }
      return platform === "windows-x64"
        ? {
            ...base,
            kind: "download",
            os: "windows",
            text: platform,
            icon: "download",
            meta: "windows",
            alt: ["macos"],
          }
        : {
            ...base,
            kind: "unavailable",
            text: platform,
            icon: "ban",
            meta: "windows",
            alt: ["macos"],
          };
    case "linux":
    case "other":
      return {
        ...base,
        kind: "unavailable",
        text: platform,
        icon: "monitor",
        alt: ["macos", ...win],
        share: true,
      };
    case "mobile":
      return { ...base, kind: "unavailable", text: platform, icon: "laptop", share: true };
  }
}
