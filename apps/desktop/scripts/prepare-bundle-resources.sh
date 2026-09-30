#!/usr/bin/env bash
# .app の Resources に同梱するもののうち、リポジトリにそのまま置けないものを
# src-tauri/bundle-resources/ (gitignore) に用意する。tauri.conf.json の bundle.resources・bundle.macOS.files が参照する。
#   bin/uv       … scripts/fetch-uv.sh で取得 (sha256 固定)。本番は Contents/Helpers/uv (bundle.macOS.files)、
#                  tauri dev は Resources の bin/uv (tauri.dev.conf.json) に置かれる
#   asr-server/  … pyproject.toml uv.lock .python-version src/ (テスト・キャッシュ・.venv は除く)
#   verify.wav   … 初回セットアップの動作確認用の合成音声。scripts/make-verify-wav.sh で .build-cache/ に一度だけ作る
# tauri-build は dev ビルドでも resources を target/ にコピーし、無いとビルドが失敗するため
# make setup (make up) と make build* の両方から呼ぶ。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/src-tauri/bundle-resources"

uv_bin="$("$root/scripts/fetch-uv.sh")"

verify_wav="$root/.build-cache/verify.wav"
if [ ! -f "$verify_wav" ]; then
  mkdir -p "$root/.build-cache"
  "$root/scripts/make-verify-wav.sh" "$verify_wav.tmp" >/dev/null
  mv "$verify_wav.tmp" "$verify_wav"
fi

# 一時ディレクトリに作ってから入れ替える (途中で失敗しても前回の内容を壊さない。
# dev 実行中の tauri-build が中途半端な状態をコピーしないように)
tmp="$out.tmp"
rm -rf "$tmp"
mkdir -p "$tmp/bin" "$tmp/asr-server"
# 署名を保つため中身はそのままコピーする (-p で実行権限・更新時刻も保つ)
/bin/cp -p "$uv_bin" "$tmp/bin/uv"

src="$root/asr-server"
for f in pyproject.toml uv.lock .python-version; do
  /bin/cp -p "$src/$f" "$tmp/asr-server/$f"
done
/bin/cp -p "$verify_wav" "$tmp/verify.wav"
# src/ 以下はパッケージのソースのみ。__pycache__ 等の生成物は入れない
/usr/bin/rsync -a --exclude '__pycache__' --exclude '*.py[co]' --exclude '.DS_Store' \
  "$src/src/" "$tmp/asr-server/src/"

# 内容が同じなら入れ替えない (更新時刻が変わると tauri-build が再実行され dev の再ビルドが走るため)
if [ -d "$out" ] && diff -rq "$tmp" "$out" >/dev/null 2>&1; then
  rm -rf "$tmp"
  echo "bundle-resources: up to date"
else
  rm -rf "$out"
  mv "$tmp" "$out"
  echo "bundle-resources: updated ($out)"
fi
