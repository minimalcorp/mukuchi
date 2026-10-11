#!/usr/bin/env bash
# WSL から Windows ネイティブの `make` を実行する (Makefile.wsl が全ターゲットをここへ渡す)。
# Windows のビルド・実行は Windows ネイティブの Rust・Node でしかできない (WSL の Rust は Linux 用) ため、
# WSL の作業ツリー (未コミット含む) を Windows 側の clone に同期してから powershell.exe で make を実行する。
# 使い方: wsl-make.sh <make の引数...>   (例: build-local / up PROVISION=1)
# 環境変数: MUKUCHI_WIN_DIR  Windows 側の clone (Windows 形式のパス。既定 C:\mukuchi-dev\mukuchi)
set -euo pipefail

WIN_DIR="${MUKUCHI_WIN_DIR:-C:\\mukuchi-dev\\mukuchi}"
SRC="$(git rev-parse --show-toplevel)"
DST="$(wslpath -u "$WIN_DIR")"

if [ ! -d "$DST" ]; then
  echo "Windows 側の作業場所が無い: $WIN_DIR" >&2
  echo "  作る: powershell.exe で  mkdir $(dirname "$WIN_DIR")  してから、この作業ツリーを同期するので" >&2
  echo "        MUKUCHI_WIN_DIR を使う場合はそのパスを Windows 形式で指定する (docs/plans/windows-plan.md)" >&2
  echo "  前提ツールの導入は $WIN_DIR\\apps\\desktop\\scripts\\install-dev-tools-windows.ps1" >&2
  mkdir -p "$DST"
fi

cd "$SRC"
# 同期の対象は git が追跡する or 未追跡で無視されていないファイル (target・node_modules 等は含めない)。
# 消したファイルは Windows 側からも消す。改行は変えない (core.autocrlf の影響を受けないため cp/rsync でバイトのまま)
list="$(mktemp)"
trap 'rm -f "$list"' EXIT
git ls-files -z --cached --others --exclude-standard | while IFS= read -r -d '' f; do
  [ -e "$f" ] && printf '%s\0' "$f"
done >"$list"
rsync -rtL --no-perms --from0 --files-from="$list" "$SRC/" "$DST/"
git ls-files -z --deleted | while IFS= read -r -d '' f; do rm -f "$DST/$f"; done

# 引数は ps1 側で make にそのまま渡す。出力が文字化けしないよう UTF-8 に揃える
exec powershell.exe -NoProfile -ExecutionPolicy Bypass \
  -File "$WIN_DIR\\apps\\desktop\\scripts\\wsl-make.ps1" -Dir "$WIN_DIR" "$@"
