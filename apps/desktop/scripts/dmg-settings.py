# .dmg の見た目 (Finder のウィンドウ) の dmgbuild 設定。scripts/build-macos.sh が
# scripts/run-dmgbuild.py -s scripts/dmg-settings.py -D background=... -D icon=... -D size=... で使う。
# 設定項目: https://dmgbuild.readthedocs.io/en/latest/settings.html (dmgbuild 1.6.7)
#
# ここで作るのは .app を含まない書き込み可能なテンプレート (UDRW)。.app は署名・公証・staple の後に
# build-macos.sh が Apple のツール (hdiutil・ditto) だけで入れる (dmgbuild を資格情報のある所で動かさないため)。
# 座標は pt、左上が原点。背景画像 (assets/brand/dmg/background.png 660x400) の矢印 (x=265..395, y≈170) の
# 両端にアイコンを置く。値を変えたら scripts/check-dmg-layout.py の期待値も直す
# ruff: noqa: F821  (defines は dmgbuild が settings を exec する時に渡す)

format = "UDRW"
filesystem = "HFS+"
# .app を後から入れる空き。dmgbuild は最後に最小サイズへ縮めるため、build-macos.sh が入れる前に広げ直す
size = defines["size"]

files = []
symlinks = {"Applications": "/Applications"}

# ボリュームアイコン (.VolumeIcon.icns + ルートの custom icon 属性。属性は /usr/bin/SetFile で付く)
icon = defines["icon"]
# 1x/2x を tiffutil -cathidpicheck でまとめた TIFF (build-macos.sh が作る)。.background.tiff として置かれる
background = defines["background"]

default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
show_icon_preview = False
show_item_info = False
include_list_view_settings = False

# ((x, y), (w, h))。x, y は画面上の位置 (y は下から。Finder が画面内に収める)。
# w, h はタイトルバー込みの枠の大きさなので、背景 660x400 に対し高さをタイトルバー分 (28pt) 足す。
# macOS 26 の標準のタイトルバーは 32pt で下端が 4pt 隠れるが、背景の下端は無地なので問題ない
# (足しすぎると背景の下に Finder の既定色の帯が出るため、隠れる側に寄せる)
window_rect = ((200, 640), (660, 428))

arrange_by = None
label_pos = "bottom"
icon_size = 128
text_size = 13
# アイコン中心の座標
icon_locations = {
    "mukuchi.app": (160, 170),
    "Applications": (500, 170),
}
