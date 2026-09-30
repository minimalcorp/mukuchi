#!/bin/bash
# メニューバーのアイコン (18pt、@1x/@2x の PNG) をロゴ (assets/brand/macos/MenuBarIcon(@2x).png) から作る。
# 元画像は黒い線 + 白い塗りのため、テンプレート画像 (黒 + アルファ。色は AppKit がメニューバーの明暗に合わせる) に
# するには「白さ」をアルファにする (白い塗りが残り、黒い線は透明に抜ける = シルエットに線が切り抜かれた形)。
# 線だけを残す形より面積が大きく、メニューバーで見やすいため (利用者の要望)。
#   logo      聞いている (Listening)
#   logo-off  オフ。デザイン (02 メニューバー) に従い 50% の濃さ
#   logo-dot  発話中・文字起こし中。右下に小さな点 (周りを切り抜いてロゴと分ける)
# エラーの赤い点 (右上) は明暗で色が変わるため、実行時に logo から描く (src/macos/status_icon.rs)。
# 再生成: ImageMagick 7 (magick) が必要。 ./generate.sh
set -euo pipefail
cd "$(dirname "$0")"
src=../../../assets/brand/macos

# 点の位置・大きさ (pt、左上原点)。右下の角に寄せる
DOT_CX=15
DOT_CY=15
DOT_R=2.5
DOT_RING=1.5

for scale in 1 2; do
  # @1x は線が 1px 未満になり灰色に混ざるため、抜いた線が消えないよう明るい側を持ち上げずに少し締める
  if [ "$scale" = 1 ]; then in="$src/MenuBarIcon.png"; suffix=""; level="25%,100%"; else in="$src/MenuBarIcon@2x.png"; suffix="@2x"; level="0%,100%"; fi
  px=$((18 * scale))
  tmp=$(mktemp -d)
  # アルファ = 元のアルファ × 輝度
  magick "$in" -resize "${px}x${px}!" \
    \( -clone 0 -alpha extract \) \
    \( -clone 0 -alpha off -colorspace gray \) \
    -delete 0 -compose multiply -composite -level "$level" "$tmp/mask.png"
  shape() { magick "$1" -background black -alpha shape -define png:color-type=6 "$2"; }
  shape "$tmp/mask.png" "logo$suffix.png"
  magick "$tmp/mask.png" -evaluate multiply 0.5 "$tmp/off.png"
  shape "$tmp/off.png" "logo-off$suffix.png"
  # 点の周りを切り抜いてから点を足す (点はロゴに重なるため)
  # magick の draw は画素の中心が整数座標のため 0.5 ずらす
  cx=$(echo "$DOT_CX * $scale - 0.5" | bc -l); cy=$(echo "$DOT_CY * $scale - 0.5" | bc -l)
  ring=$(echo "($DOT_R + $DOT_RING) * $scale" | bc -l); r=$(echo "$DOT_R * $scale" | bc -l)
  magick "$tmp/mask.png" \
    \( -size "${px}x${px}" xc:white -fill black -draw "circle $cx,$cy $(echo "$cx + $ring" | bc -l),$cy" \) \
    -compose multiply -composite \
    \( -size "${px}x${px}" xc:black -fill white -draw "circle $cx,$cy $(echo "$cx + $r" | bc -l),$cy" \) \
    -compose lighten -composite "$tmp/dot.png"
  shape "$tmp/dot.png" "logo-dot$suffix.png"
  rm -rf "$tmp"
done
