import type { InputMode } from "./ipc";

/** 入力モードの名前・説明・向いている場面。セットアップと設定で同じ言葉を使うためここに置く */
export const INPUT_MODES: { id: InputMode; label: string; description: string; useCases: string[] }[] = [
  {
    id: "continuous",
    label: "常に聞き取る",
    description: "オンの間、話すたびに文字にします",
    useCases: ["ひとりで作業しているとき", "話すだけで次々に入力したいとき"],
  },
  {
    id: "oneShot",
    label: "1回ずつ聞き取る",
    description: "ショートカットを押してから話し終わるまでを1回だけ文字にします",
    useCases: ["周りに人がいる・会話が聞こえる場所", "入力するタイミングを自分で決めたいとき"],
  },
];

/** ショートカットの働きの説明 (入力モードで変わる) */
export const SHORTCUT_HINT: Record<InputMode, string> = {
  continuous: "押すたびに音声入力をオン／オフします",
  oneShot: "押すと1回聞き取ります。話し終わると自動でオフになります",
};
