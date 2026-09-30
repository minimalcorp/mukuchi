#!/usr/bin/env bash
# .app に同梱する uv (aarch64-apple-darwin) を取得し、キャッシュのパスを標準出力に出す。
# バイナリはリポジトリに置かない (公開リポジトリに第三者のバイナリを入れないため)。
#
# バージョンは devShell (nixpkgs) の uv と揃える (uv.lock を作った uv と同じ挙動にするため)。
# sha256 は GitHub Release の uv-aarch64-apple-darwin.tar.gz.sha256 の値を転記して固定する
# (取得のたびに同じサーバーの .sha256 と照合するだけでは改ざんを検出できないため)。
# 更新時: https://github.com/astral-sh/uv/releases/download/<ver>/uv-aarch64-apple-darwin.tar.gz.sha256
set -euo pipefail

UV_VERSION=0.12.17
UV_SHA256=85f00cbdc6dd3e97eba4c31b4d014375a9fdfe8f570023b84e5102fc3456896b
UV_TARGET=aarch64-apple-darwin

root="$(cd "$(dirname "$0")/.." && pwd)"
cache="$root/.build-cache/uv/$UV_VERSION"
bin="$cache/uv"

# 展開済みでも tarball のハッシュを確認し直す (キャッシュが壊れた・差し替えられた場合に備える)
tarball="$cache/uv-$UV_TARGET.tar.gz"
verify() { echo "$UV_SHA256  $tarball" | /usr/bin/shasum -a 256 -c --status; }

if [ -f "$bin" ] && [ -f "$tarball" ] && verify; then
  echo "$bin"
  exit 0
fi

mkdir -p "$cache"
url="https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$UV_TARGET.tar.gz"
echo "==> download uv $UV_VERSION ($url)" >&2
curl -fsSL --retry 3 -o "$tarball.part" "$url"
mv "$tarball.part" "$tarball"
if ! verify; then
  echo "error: sha256 不一致: $tarball (期待値 $UV_SHA256)" >&2
  rm -f "$tarball"
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$tarball" -C "$tmp"
install -m 0755 "$tmp/uv-$UV_TARGET/uv" "$bin"
# 開発元 (Astral) の Developer ID 署名・Hardened Runtime・公証済みのまま使う (再署名しない)。
# ライセンスは tarball に含まれないため THIRD_PARTY_NOTICES に記載している
/usr/bin/codesign --verify --strict "$bin"
echo "$bin"
