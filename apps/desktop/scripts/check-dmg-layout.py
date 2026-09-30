#!/usr/bin/env python3
"""マウントした .dmg の見た目 (scripts/dmg-settings.py で作ったもの) が想定どおりかを確かめる。

    python3 scripts/check-dmg-layout.py <マウントポイント> [--template]

--template は .app を入れる前のテンプレート (build-macos.sh がテンプレート作成直後に使う)。
make verify は署名 job (依存を入れない) でも動くため、ds_store 等に頼らず標準ライブラリだけで .DS_Store を読む。
.DS_Store のレコードは「名前 (UTF-16BE, 長さ付き) + 4文字のコード + 型 + 値」の並びなので、
必要なレコードをバイト列から探す (dmgbuild が1回だけ書いた .DS_Store が前提。Finder で開いて保存し直した物は対象外)。
問題があれば理由を表示して終了コード 1。
"""

from __future__ import annotations

import plistlib
import re
import struct
import subprocess
import sys
from pathlib import Path

# scripts/dmg-settings.py と合わせる
APP = "mukuchi.app"
ICON_LOCATIONS = {APP: (160, 170), "Applications": (500, 170)}
ICON_SIZE = 128.0
TEXT_SIZE = 13.0
WINDOW_SIZE = (660, 428)
BACKGROUND = ".background.tiff"
# 背景 TIFF の画像 (幅, 高さ, 解像度 dpi)。1x と Retina 用 2x
BACKGROUND_REPS = [(660, 400, 72), (1320, 800, 144)]
ROOT = Path(__file__).resolve().parent.parent
VOLUME_ICON_SRC = ROOT / "src-tauri/icons/icon.icns"

errors: list[str] = []


def err(msg: str) -> None:
    errors.append(msg)


def records(data: bytes, name: str, code: bytes, typ: bytes) -> list[bytes]:
    """name・code・typ が一致するレコードの値部分 (以降のバイト列) を返す。"""
    enc = name.encode("utf-16-be")
    pat = re.escape(struct.pack(">I", len(name)) + enc + code + typ)
    return [data[m.end() :] for m in re.finditer(pat, data)]


def one_blob(data: bytes, name: str, code: bytes) -> bytes | None:
    found = records(data, name, code, b"blob")
    if len(found) != 1:
        err(f".DS_Store: {name!r} の {code.decode()} が {len(found)} 個 (1個のはず)")
        return None
    (n,) = struct.unpack(">I", found[0][:4])
    return found[0][4 : 4 + n]


def main() -> int:
    args = sys.argv[1:]
    template = "--template" in args
    args = [a for a in args if a != "--template"]
    if len(args) != 1:
        print(__doc__, file=sys.stderr)
        return 2
    mnt = Path(args[0])

    # 見える項目は .app と Applications だけ。隠しファイルは dmgbuild が置くものだけ許す
    # (.fseventsd は書き込み可能でマウントした時に作られうる。Finder には表示されない)
    visible = {APP, "Applications"} - ({APP} if template else set())
    hidden_ok = {".DS_Store", BACKGROUND, ".VolumeIcon.icns", ".fseventsd"}
    names = {p.name for p in mnt.iterdir()}
    if {n for n in names if not n.startswith(".")} != visible:
        err(f"ルートの項目が想定と違う: {sorted(names)} (見える項目は {sorted(visible)} のみのはず)")
    extra_hidden = {n for n in names if n.startswith(".")} - hidden_ok
    if extra_hidden:
        err(f"想定外の隠しファイル: {sorted(extra_hidden)}")

    apps = mnt / "Applications"
    if not apps.is_symlink() or apps.readlink() != Path("/Applications"):
        err("Applications が /Applications へのシンボリックリンクでない")

    # ボリュームアイコン: 中身がアプリアイコンと同じで、ルートに custom icon 属性 (kHasCustomIcon 0x0400) がある
    vi = mnt / ".VolumeIcon.icns"
    if not vi.is_file() or vi.read_bytes() != VOLUME_ICON_SRC.read_bytes():
        err(f".VolumeIcon.icns が {VOLUME_ICON_SRC.relative_to(ROOT)} と違う")
    fi = subprocess.run(
        ["/usr/bin/xattr", "-px", "com.apple.FinderInfo", str(mnt)], capture_output=True, text=True
    )
    fi_bytes = bytes.fromhex(fi.stdout.replace(" ", "").replace("\n", "")) if fi.returncode == 0 else b""
    if len(fi_bytes) < 10 or not (struct.unpack(">H", fi_bytes[8:10])[0] & 0x0400):
        err("ボリュームのルートに custom icon 属性がない (/usr/bin/SetFile -a C が失敗した可能性)")

    # 背景: 1x と 2x を持つ TIFF (Retina で 2x が使われる)
    bg = mnt / BACKGROUND
    info = subprocess.run(["/usr/bin/tiffutil", "-info", str(bg)], capture_output=True, text=True)
    reps = [
        (int(w), int(h), int(r))
        for w, h, r in re.findall(
            r"Image Width: (\d+) Image Length: (\d+)\s+Resolution: (\d+)", info.stdout
        )
    ]
    if reps != BACKGROUND_REPS:
        err(f"{BACKGROUND} の画像が想定と違う: {reps} (想定 {BACKGROUND_REPS})")

    ds = (mnt / ".DS_Store").read_bytes() if (mnt / ".DS_Store").is_file() else b""
    if not ds:
        err(".DS_Store がない")
    else:
        for name, (x, y) in ICON_LOCATIONS.items():
            # .app を入れる前のテンプレートにも .app の位置は入っている (レコードは名前で引く)
            b = one_blob(ds, name, b"Iloc")
            if b is not None and struct.unpack(">II", b[:8]) != (x, y):
                err(f"{name} の位置が {struct.unpack('>II', b[:8])} (想定 {(x, y)})")

        icvp = one_blob(ds, ".", b"icvp")
        if icvp is not None:
            v = plistlib.loads(icvp)
            want = {"backgroundType": 2, "arrangeBy": "none", "iconSize": ICON_SIZE, "textSize": TEXT_SIZE, "labelOnBottom": True}
            got = {k: v.get(k) for k in want}
            if got != want:
                err(f"icvp (アイコン表示の設定) が想定と違う: {got} (想定 {want})")
            if BACKGROUND.encode() not in v.get("backgroundImageAlias", b""):
                err(f"背景のエイリアスが {BACKGROUND} を指していない")

        bwsp = one_blob(ds, ".", b"bwsp")
        if bwsp is not None:
            v = plistlib.loads(bwsp)
            for k in ("ShowToolbar", "ShowStatusBar", "ShowSidebar", "ShowPathbar", "ShowTabView"):
                if v.get(k) is not False:
                    err(f"bwsp の {k} が {v.get(k)} (False のはず)")
            m = re.fullmatch(r"\{\{-?\d+, -?\d+\}, \{(\d+), (\d+)\}\}", v.get("WindowBounds", ""))
            if not m or (int(m[1]), int(m[2])) != WINDOW_SIZE:
                err(f"ウィンドウの大きさが {v.get('WindowBounds')} (想定 {WINDOW_SIZE})")

        icvl = records(ds, ".", b"icvl", b"type")
        if len(icvl) != 1 or icvl[0][:4] != b"icnv":
            err("既定の表示がアイコン表示 (icvl=icnv) でない")

    for e in errors:
        print(e)
    if not errors:
        print(f"layout OK: {APP} {ICON_LOCATIONS[APP]}, Applications {ICON_LOCATIONS['Applications']}, "
              f"icon {ICON_SIZE:g}pt, text {TEXT_SIZE:g}pt, window {WINDOW_SIZE}, background 1x+2x")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
