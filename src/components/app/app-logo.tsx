import logo64 from "@/assets/brand/mukuchi-logo_64.png";
import logo128 from "@/assets/brand/mukuchi-logo_128.png";
import { cn } from "@/lib/utils";

/**
 * アプリのロゴタイル (設定 > このアプリについて・セットアップのようこそ)。
 * ロゴは黒の線画なので、ダークモードでも地は白のまま (線画が背景に沈まないように)。
 * 画像は 1x で 64px・2x で 128px を使う (表示は 32〜36px 程度)
 */
export function AppLogo({ size, className }: { size: 44 | 48; className?: string }) {
  return (
    <div
      className={cn(
        "flex flex-none items-center justify-center rounded-[10px] border border-line-default bg-gray-0 p-1.5",
        size === 48 ? "size-12" : "size-11",
        className,
      )}
    >
      <img src={logo128} srcSet={`${logo64} 1x, ${logo128} 2x`} alt="mukuchi" className="size-full object-contain" draggable={false} />
    </div>
  );
}
