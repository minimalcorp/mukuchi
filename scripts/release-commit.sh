#!/usr/bin/env bash
# リリースの版上げコミットを HEAD の上に作る (.github/workflows/release.yml の各 job が使う)。
#
#   scripts/release-commit.sh <desktop|web> <patch|minor|major> <epoch> [<期待するコミット ID>]
#
# 標準出力に GITHUB_OUTPUT 形式で version=・previous=・tag=・commit= を出す (他は標準エラー)。
# 期待するコミット ID を渡すと、作ったコミットが違えば失敗する (別の job で作ったものと同じかの確認)。
#
# 作者・日時 (<epoch>、UNIX 秒)・メッセージを固定するため、同じ HEAD から作れば別の job でも同じコミット ID になる。
# ビルドする job (secret なし) と main へ push する job (Deploy Key あり) を分けても、push するコミットが
# ビルドしたソースそのものであることを ID の一致で確かめられる。desktop では .app に埋め込むコミットの短縮ハッシュ
# (src-tauri/build.rs) もこのコミットになる。
set -euo pipefail

if [ $# -ne 3 ] && [ $# -ne 4 ]; then
  echo "usage: $0 <desktop|web> <patch|minor|major> <epoch> [<expected-commit>]" >&2
  exit 2
fi
target="$1" kind="$2" epoch="$3" expected="${4:-}"
[[ "$epoch" =~ ^[0-9]+$ ]] || { echo "epoch は UNIX 秒: '$epoch'" >&2; exit 2; }

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"

if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "作業ツリーに未コミットの変更がある" >&2
  git status --short >&2
  exit 1
fi

result="$(node scripts/bump-version.mjs "$target" "$kind")"
echo "$result" >&2
version="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).to)' "$result")"
previous="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).from)' "$result")"
tag="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).tag)' "$result")"
# macOS の /bin/bash (3.2) でも動くよう mapfile を使わない
node -e 'for (const f of JSON.parse(process.argv[1]).files) console.log(f)' "$result" | while IFS= read -r f; do
  git add -- "$f"
done
# 環境 (runner のユーザー設定・署名設定) に左右されないよう、コミットに効く設定をすべて明示する
GIT_AUTHOR_NAME="github-actions[bot]" \
GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com" \
GIT_AUTHOR_DATE="@$epoch +0000" \
GIT_COMMITTER_NAME="github-actions[bot]" \
GIT_COMMITTER_EMAIL="41898282+github-actions[bot]@users.noreply.github.com" \
GIT_COMMITTER_DATE="@$epoch +0000" \
  git -c commit.gpgsign=false -c core.hooksPath=/dev/null commit --quiet --no-verify \
  -m "chore(release): $target v$version"

commit="$(git rev-parse HEAD)"
if [ -n "$expected" ] && [ "$commit" != "$expected" ]; then
  echo "版上げコミット $commit が期待 ($expected) と違う (ビルド・デプロイしたものと同じソースでない)" >&2
  exit 1
fi

echo "version=$version"
echo "previous=$previous"
echo "tag=$tag"
echo "commit=$commit"
