import type { ReactNode } from "react";
import { Tooltip } from "@/components/ui/tooltip";

/**
 * 未実装の command (Rust が `not_implemented:` で reject) に対応する操作の包み。
 * active の間は中身 (無効化したボタン等) に「未対応」の Tooltip を付ける。
 * 無効なボタンはポインタイベントを受けないため、span で包んで Tooltip を出す。
 */
export function Unimplemented({ active, children }: { active: boolean; children: ReactNode }) {
  if (!active) return children;
  return (
    <Tooltip content="この版では未対応です">
      <span tabIndex={0} data-testid="unimplemented" className="inline-flex rounded-md outline-none focus-visible:shadow-[var(--focus-ring)]">
        {children}
      </span>
    </Tooltip>
  );
}
