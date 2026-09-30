import { Tooltip as TooltipPrimitive } from "radix-ui";
import { CircleHelp } from "lucide-react";
import type * as React from "react";

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={200} skipDelayDuration={0}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

// ツールチップ。長い補足がウィンドウからはみ出さないよう、1 行にせず最大幅で折り返す
export function Tooltip({
  content,
  side = "top",
  children,
}: {
  content: React.ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  children: React.ReactNode;
}) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-[70] max-w-[280px] animate-[fade-in_var(--duration-fast)_var(--ease-out)] rounded-sm bg-gray-900 px-2 py-[5px] text-xs leading-[1.4] font-normal text-gray-0 shadow-md"
        >
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/** 補足の「?」アイコン + Tooltip */
export function HelpTip({ content }: { content: React.ReactNode }) {
  return (
    <Tooltip content={content}>
      <button
        type="button"
        aria-label="説明"
        className="inline-flex cursor-help items-center border-0 bg-transparent p-0 text-fg-subtle"
      >
        <CircleHelp size={14} aria-hidden />
      </button>
    </Tooltip>
  );
}
