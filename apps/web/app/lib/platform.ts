// 閲覧中の OS・CPU の判定。ボタンの出し分けはデザイン (1b LP の ctaMap) に従う

export const PLATFORMS = [
  "mac-arm",
  "mac-unknown",
  "mac-intel",
  "windows",
  "linux",
  "mobile",
  "other",
] as const;
export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(value: unknown): value is Platform {
  return typeof value === "string" && (PLATFORMS as readonly string[]).includes(value);
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

/**
 * CPU の種類を取れるのは Chrome・Edge (UA-CH の architecture) だけ。
 * Safari・Firefox は Apple Silicon と Intel を区別できないので mac-unknown (ダウンロード可・Intel 非対応の注記) にする。
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
    try {
      if (uad?.getHighEntropyValues) {
        const v = await uad.getHighEntropyValues(["architecture"]);
        if (v.architecture === "arm") return "mac-arm";
        if (v.architecture === "x86") return "mac-intel";
      }
    } catch {
      // 取得を拒否された場合は判定不可として扱う
    }
    return "mac-unknown";
  }
  if (/win/.test(plat)) return "windows";
  if (/linux/.test(plat) && !/Android/.test(ua)) return "linux";
  return "other";
}

/** ボタンの出し分け (文言は辞書の cta.states) */
export interface CtaState {
  kind: "download" | "unavailable";
  icon: "download" | "ban" | "clock" | "laptop" | "monitor";
  noteIcon: "circle-check" | "info";
  noteTone: "success" | "muted";
}

const INFO = { noteIcon: "info", noteTone: "muted" } as const;

export const CTA: Record<Platform, CtaState> = {
  "mac-arm": { kind: "download", icon: "download", noteIcon: "circle-check", noteTone: "success" },
  "mac-unknown": { kind: "download", icon: "download", ...INFO },
  "mac-intel": { kind: "unavailable", icon: "ban", ...INFO },
  windows: { kind: "unavailable", icon: "clock", ...INFO },
  linux: { kind: "unavailable", icon: "clock", ...INFO },
  mobile: { kind: "unavailable", icon: "laptop", ...INFO },
  other: { kind: "unavailable", icon: "monitor", ...INFO },
};
