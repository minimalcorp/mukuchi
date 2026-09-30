/*
 * パネル (ピル・カード) のドラッグ移動。
 * data-tauri-drag-region はボタン上では効かず、OFF のピルはほぼ全体がボタンのため掴める場所がない。
 * そこで押下後に一定距離動いたらウィンドウのドラッグを始め、動かさずに離した時だけクリック (ボタンの操作) とする。
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useRef, type MouseEvent, type PointerEvent } from "react";

// これ未満の移動はクリック中の手ぶれとみなす
const DRAG_THRESHOLD_PX = 4;

export function usePanelDrag() {
  // ドラッグを始めた押下か。直後のクリック (ボタンの操作) を打ち消すために使う
  const draggedRef = useRef(false);
  // 押下中の window リスナーの解除
  const cleanupRef = useRef<(() => void) | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    // ネイティブのドラッグが始まると pointerup が届かないことがあるため、前回の状態は押下のたびに捨てる
    cleanupRef.current?.();
    draggedRef.current = false;
    if (e.button !== 0 || !e.isPrimary) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const onMove = (ev: globalThis.PointerEvent) => {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD_PX) return;
      draggedRef.current = true;
      cleanup();
      getCurrentWindow()
        .startDragging()
        .catch((err: unknown) => console.warn("ウィンドウのドラッグを開始できませんでした", err));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      cleanupRef.current = null;
    };
    // ポインターキャプチャはクリックの対象がボタンから外れるため使わない
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
    cleanupRef.current = cleanup;
  };

  const onClickCapture = (e: MouseEvent<HTMLElement>) => {
    // detail === 0 はキーボード (Enter / Space) による操作。ドラッグの後でも打ち消さない
    if (draggedRef.current && e.detail !== 0) {
      e.preventDefault();
      e.stopPropagation();
    }
    draggedRef.current = false;
  };

  return { onPointerDown, onClickCapture };
}
