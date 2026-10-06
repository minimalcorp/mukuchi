import { createElement, Fragment, type ReactNode } from "react";

/**
 * 文中に要素 (キー表示等) を差し込む文言用。辞書の関数から返す。
 * 子を可変長引数で渡すため key は要らない (語順は言語ごとに辞書が決める)
 */
export function rich(...children: ReactNode[]): ReactNode {
  return createElement(Fragment, null, ...children);
}
