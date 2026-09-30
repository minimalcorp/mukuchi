#!/bin/bash
# メニューバーのアイコン (18pt、@1x/@2x の PNG) を lucide の SVG から作る。
# 形は lucide (ISC License, THIRD_PARTY_NOTICES 参照) の mic / mic-off / audio-lines / loader-circle。
# 16pt のグリフを 18pt の枠の中央に置く (エラー時の赤い点を右上に重ねる余白)。
# OFF はデザイン (02 メニューバー) に従い 50% の濃さにする。テンプレート画像なので色は黒のみ。
# 再生成: rsvg-convert (librsvg) が必要。 ./generate.sh
set -euo pipefail
cd "$(dirname "$0")"

render() { # <name> <opacity> <svg要素>
  # 18 単位の枠に 24 単位の lucide を 16/24 倍で置く (余白 1)
  local svg="<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"18\" height=\"18\" viewBox=\"0 0 18 18\">
<g transform=\"translate(1 1) scale(0.6666667)\" fill=\"none\" stroke=\"#000\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" opacity=\"$2\">$3</g></svg>"
  printf '%s' "$svg" | rsvg-convert -w 18 -h 18 -o "$1.png"
  printf '%s' "$svg" | rsvg-convert -w 36 -h 36 -o "$1@2x.png"
}

render mic 1 '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>'
render mic-off 0.5 '<path d="M12 19v3"/><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/><path d="M16.95 16.95A7 7 0 0 1 5 12v-2"/><path d="M18.89 13.23A7 7 0 0 0 19 12v-2"/><path d="m2 2 20 20"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12"/>'
render audio-lines 1 '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>'
render loader-circle 1 '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>'
