/*
 * パネル (ピル・カード) のドラッグ移動。
 * data-tauri-drag-region はボタン上では効かず、OFF のピルはほぼ全体がボタンのため掴める場所がない。
 * そこで押下後に一定距離動いたらウィンドウのドラッグを始め、動かさずに離した時だけクリック (ボタンの操作) とする。
 * 右クリック (macOS の control + クリックを含む) はドラッグ・クリックにせず、メニュー (show_panel_menu) を出す。
 */
import { getCurrentWindow } from "@tauri-apps/api/window";
import { commands, runCommand } from "@/lib/ipc";
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
    // control + 左ボタンは macOS では右クリック (contextmenu) の扱い。ドラッグにしない
    if (e.button !== 0 || !e.isPrimary || e.ctrlKey) return;
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
    // control + クリックは contextmenu でメニューを出すので、ボタンの操作にはしない
    if ((draggedRef.current || e.ctrlKey) && e.detail !== 0) {
      e.preventDefault();
      e.stopPropagation();
    }
    draggedRef.current = false;
  };

  const onContextMenu = (e: MouseEvent<HTMLElement>) => {
    e.preventDefault();
    // ウィンドウ内の座標 (CSS px = 論理 px)。メニューバーのアイコンがノッチで隠れても同じメニューを出せるようにする
    runCommand(commands.showPanelMenu(e.clientX, e.clientY));
  };

  return { onPointerDown, onClickCapture, onContextMenu };
}
