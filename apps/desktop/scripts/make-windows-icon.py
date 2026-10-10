# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Windows 用のアイコン (icons/icon.ico) をブランド素材から作る。

使い方: uv run apps/desktop/scripts/make-windows-icon.py
元画像: assets/brand/logo/mukuchi-logo_1024.png (余白の少ない透過 PNG。macOS のアイコンは Apple のグリッド用の余白が
付いていて Windows では小さく見えるため、こちらを使う)。16〜256px の PNG を 1 つの .ico にまとめる
(Vista 以降は PNG 圧縮の ico を読める)。小さいサイズは個別に縮小し直して作る (1 枚から自動で縮めるより潰れにくい)。
"""

import io
import struct
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / "assets/brand/logo/mukuchi-logo_1024.png"
OUT = ROOT / "apps/desktop/src-tauri/icons/icon.ico"
SIZES = [16, 24, 32, 48, 64, 128, 256]

src = Image.open(SRC).convert("RGBA")
entries = []
for s in SIZES:
    buf = io.BytesIO()
    src.resize((s, s), Image.LANCZOS).save(buf, format="PNG", optimize=True)
    entries.append((s, buf.getvalue()))

# ICONDIR (6 バイト) + ICONDIRENTRY (16 バイト) x N + 画像
header = struct.pack("<HHH", 0, 1, len(entries))
offset = 6 + 16 * len(entries)
directory = b""
body = b""
for s, data in entries:
    directory += struct.pack("<BBBBHHII", s % 256, s % 256, 0, 0, 1, 32, len(data), offset + len(body))
    body += data
OUT.write_bytes(header + directory + body)
print(f"{OUT} ({OUT.stat().st_size} bytes, sizes={SIZES})")
