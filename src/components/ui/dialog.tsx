import { Dialog as DialogPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export const DialogClose = DialogPrimitive.Close;

// DS の Dialog のオーバーレイ・面。レイアウトは各ダイアログで組む (デザインのアンインストール確認に合わせる)
export function DialogContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-[60] animate-[ds-fade_var(--duration-normal)_var(--ease-out)] bg-surface-overlay" />
      <DialogPrimitive.Content
        className={cn(
          "fixed top-1/2 left-1/2 z-[61] flex w-[400px] max-w-[calc(100%-48px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-surface-card shadow-dialog outline-none",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
