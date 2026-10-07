import { CircleAlert, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { commands, runCommand } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/context";

// ref は同じ関数を渡し続けることで表示された時だけ呼ばれる (再描画のたびにスクロールさせない)
const revealOnMount = (el: HTMLElement | null) => el?.scrollIntoView({ block: "nearest" });

/**
 * 「ログイン時に起動」を切り替えられなかった時のエラー (Rust の表示用メッセージ) と、ログイン項目を開くボタン。
 * ON にしても承認待ち (システム設定 > 一般 > ログイン項目 でオフ) だと有効にならず、利用者が承認するしかないため。
 */
export function LaunchAtLoginError({ message, className }: { message: string | null | undefined; className?: string }) {
  const { t } = useI18n();
  if (!message) return null;
  return (
    // setup の完了画面では本文がスクロール領域の下端に収まらず、ボタンが見えないまま出ることがあるため、出た時に見える位置へ寄せる
    <div role="alert" ref={revealOnMount} className={cn("flex flex-col items-start gap-2", className)}>
      <p className="m-0 flex items-start gap-1.5 text-xs leading-[1.5] text-fg-danger">
        <CircleAlert size={14} className="mt-px flex-none" aria-hidden />
        <span>{message}</span>
      </p>
      <Button size="sm" iconRight={ExternalLink} onClick={() => runCommand(commands.openSystemSettings("login_items"))}>
        {t.common.openSystemSettings}
      </Button>
    </div>
  );
}
