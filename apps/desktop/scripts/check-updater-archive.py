#!/usr/bin/env python3
"""updater 用の mukuchi_aarch64.app.tar.gz の中身を確かめる (標準ライブラリのみ。署名の job でも動かすため)。

  check-updater-archive.py <tar.gz> [--app <mukuchi.app>]

tauri-plugin-updater 2.13 (macOS) は各エントリのパスの先頭の要素を1つ捨てて一時ディレクトリに展開し、
それを .app と置き換える (updater.rs の install_inner)。そのため:
  - すべてのエントリが mukuchi.app か mukuchi.app/ の下 (./ 起点・絶対パス・.. は不可)
  - AppleDouble (._*) や xattr・ACL の pax ヘッダーを含まない (展開すると .app に余計なファイルができ署名が壊れる)
  - 通常のファイル・ディレクトリ・.app 内を指す相対シンボリックリンクのみ (ハードリンク・デバイス等は不可)
  - 本体・Info.plist・署名 (_CodeSignature/CodeResources)・公証の票 (staple。Contents/CodeResources) がある
--app を渡すと、.app のファイル一覧・種類・中身 (sha256) が tar と一致することも確かめる。
"""

import hashlib
import os
import sys
import tarfile

TOP = "mukuchi.app"
REQUIRED = [
    "Contents/Info.plist",
    "Contents/MacOS/mukuchi",
    "Contents/_CodeSignature/CodeResources",
    # stapler staple が書く公証の票 (バンドルの場合はこの場所)
    "Contents/CodeResources",
]
BAD_PAX = ("LIBARCHIVE.xattr.", "SCHILY.xattr.", "SCHILY.acl.", "LIBARCHIVE.acl")


def sha256(f):
    h = hashlib.sha256()
    for chunk in iter(lambda: f.read(1 << 20), b""):
        h.update(chunk)
    return h.hexdigest()


def main(argv):
    if len(argv) not in (1, 3) or (len(argv) == 3 and argv[1] != "--app"):
        print(__doc__, file=sys.stderr)
        return 2
    archive = argv[0]
    app = argv[2] if len(argv) == 3 else None
    errors = []
    entries = {}
    with tarfile.open(archive, "r:gz") as tf:
        for m in tf:
            name = m.name
            parts = name.rstrip("/").split("/")
            if name.startswith("/") or name.startswith("./") or ".." in parts or "." in parts:
                errors.append(f"不正なパス: {name!r}")
                continue
            if parts[0] != TOP:
                errors.append(f"{TOP}/ の外: {name!r}")
                continue
            if any(p.startswith("._") for p in parts):
                errors.append(f"AppleDouble: {name!r}")
            bad = [k for k in m.pax_headers if k.startswith(BAD_PAX)]
            if bad:
                errors.append(f"xattr/ACL の pax ヘッダー {bad}: {name!r}")
            rel = "/".join(parts[1:])
            if m.isreg():
                kind = ("file", m.mode & 0o111 != 0, sha256(tf.extractfile(m)) if app else None)
            elif m.isdir():
                kind = ("dir",)
            elif m.issym():
                target = os.path.normpath(os.path.join(os.path.dirname(rel), m.linkname))
                if m.linkname.startswith("/") or target == ".." or target.startswith("../"):
                    errors.append(f".app の外を指すシンボリックリンク: {name!r} -> {m.linkname!r}")
                kind = ("symlink", m.linkname)
            else:
                errors.append(f"未対応の種類 ({m.type!r}): {name!r}")
                continue
            if rel in entries:
                errors.append(f"重複: {name!r}")
            entries[rel] = kind

    if "" not in entries:
        errors.append(f"最上位のディレクトリ {TOP}/ のエントリがない")
    for r in REQUIRED:
        if entries.get(r, ("",))[0] != "file":
            errors.append(f"{TOP}/{r} がない")

    if app:
        ondisk = {}
        for dirpath, dirnames, filenames in os.walk(app):
            for n in dirnames + filenames:
                p = os.path.join(dirpath, n)
                rel = os.path.relpath(p, app)
                if os.path.islink(p):
                    ondisk[rel] = ("symlink", os.readlink(p))
                elif os.path.isdir(p):
                    ondisk[rel] = ("dir",)
                else:
                    with open(p, "rb") as f:
                        ondisk[rel] = ("file", os.stat(p).st_mode & 0o111 != 0, sha256(f))
        ondisk[""] = ("dir",)
        for rel in sorted(set(ondisk) | set(entries)):
            if ondisk.get(rel) != entries.get(rel):
                errors.append(f".app と違う: {rel or '.'} (.app {ondisk.get(rel)} / tar {entries.get(rel)})")

    if errors:
        for e in errors[:50]:
            print(f"error: {e}", file=sys.stderr)
        if len(errors) > 50:
            print(f"error: ほか {len(errors) - 50} 件", file=sys.stderr)
        return 1
    print(f"ok: {archive} ({len(entries)} entries{', .app と一致' if app else ''})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
