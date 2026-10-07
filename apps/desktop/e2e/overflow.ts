/*
 * 文字のはみ出し・切れの検出。英語など長くなる文言で、ボタンや枠から文字が出る・切れるのを見つける。
 * 表示中の文字を持つ要素ごとに
 * - 要素の中身が要素の幅に収まっているか (scrollWidth > clientWidth で切れていないか)
 * - 文字の矩形が祖先の箱 (inline を除く) の内側にあるか (スクロールする祖先から先は、その向きを見ない)
 * - 横にスクロールする所ができていないか
 * を確かめる。意図して省略・切り取っているもの (text-overflow: ellipsis・line-clamp・ALLOWED の要素の中) は除く。
 */
import type { Page } from "@playwright/test";
import { settleAnimations } from "./fixtures";

/** 意図して切り取って表示する所 (パネルのプレビューは古い行を上に送って 3 行に収める) */
const ALLOWED = ['[data-testid="preview"]'];

export type Overflow = { text: string; element: string; reason: string };

/** 表示中の文字のはみ出し・切れを返す (なければ空) */
export async function findOverflows(page: Page): Promise<Overflow[]> {
  // 展開・切り替えの途中 (カードが広がる途中等) で測らない
  await settleAnimations(page);
  return page.evaluate((allowed) => {
    const TOL = 1;
    const out: { text: string; element: string; reason: string }[] = [];
    const describe = (el: Element) => {
      const id = el.getAttribute("data-testid");
      const cls = typeof el.className === "string" ? el.className.split(/\s+/).slice(0, 4).join(".") : "";
      return `${el.tagName.toLowerCase()}${id ? `[data-testid=${id}]` : ""}${cls ? `.${cls}` : ""}`;
    };
    /** 要素か祖先が省略表示 (ellipsis・line-clamp) か */
    const truncated = (el: Element | null): boolean => {
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.textOverflow === "ellipsis") return true;
        const clamp = s.getPropertyValue("-webkit-line-clamp");
        if (clamp && clamp !== "none") return true;
      }
      return false;
    };
    const scrolls = (v: string) => v === "auto" || v === "scroll";

    for (const el of document.body.querySelectorAll("*")) {
      const texts = [...el.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
      if (texts.length === 0) continue;
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      if (el.closest(".sr-only") || allowed.some((sel) => el.closest(sel))) continue;
      if (truncated(el)) continue;
      const text = texts.map((n) => n.textContent!.trim()).join(" ").slice(0, 60);
      const style = getComputedStyle(el);

      // 要素の中身が要素の幅を超える (overflow: hidden なら切れ、visible なら外へ出る)
      if (style.display !== "inline" && el.scrollWidth > el.clientWidth + TOL && el.clientWidth > 0) {
        out.push({ text, element: describe(el), reason: `scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth}` });
        continue;
      }

      // 文字の矩形が祖先の箱の外に出ていないか
      const rects: DOMRect[] = [];
      for (const node of texts) {
        const range = document.createRange();
        range.selectNodeContents(node);
        rects.push(...[...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0));
      }
      // 文字の矩形はフォントの高さで、行の高さ (line-height) が小さいとその分だけ行の箱から上下に出る。見た目のはみ出しではないので許す
      const lineHeight = parseFloat(style.lineHeight);
      const yTol = (r: DOMRect) => TOL + (Number.isNaN(lineHeight) ? 0 : Math.max(0, (r.height - lineHeight) / 2));
      let checkX = true;
      let checkY = true;
      let found: string | null = null;
      for (let a: Element | null = el; a && a !== document.documentElement && !found; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.display === "inline" || s.display === "contents") continue;
        // スクロールする祖先では、その向きのはみ出しはスクロールで見えるので、そこから外は見ない
        // (横のスクロールが出てしまうことは、下でスクロールする要素ごとに確かめる)
        if (scrolls(s.overflowX)) checkX = false;
        if (scrolls(s.overflowY)) checkY = false;
        if (!checkX && !checkY) break;
        const box = a.getBoundingClientRect();
        for (const r of rects) {
          if (checkX && (r.left < box.left - TOL || r.right > box.right + TOL)) {
            found = `文字が ${describe(a)} の幅の外 (文字 ${r.left.toFixed(1)}–${r.right.toFixed(1)}, 箱 ${box.left.toFixed(1)}–${box.right.toFixed(1)})`;
            break;
          }
          if (checkY && (r.top < box.top - yTol(r) || r.bottom > box.bottom + yTol(r))) {
            found = `文字が ${describe(a)} の高さの外 (文字 ${r.top.toFixed(1)}–${r.bottom.toFixed(1)}, 箱 ${box.top.toFixed(1)}–${box.bottom.toFixed(1)})`;
            break;
          }
        }
      }
      if (found) out.push({ text, element: describe(el), reason: found });
    }
    // 横にスクロールする所ができていないか (縦にだけスクロールする領域でも、幅を超えると横のスクロールが出る)
    for (const el of document.body.querySelectorAll("*")) {
      if (!scrolls(getComputedStyle(el).overflowX) || allowed.some((sel) => el.closest(sel))) continue;
      if (el.scrollWidth > el.clientWidth + TOL) {
        out.push({ text: "", element: describe(el), reason: `横にスクロールする (scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth})` });
      }
    }
    return out;
  }, ALLOWED);
}
