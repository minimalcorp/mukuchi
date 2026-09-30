#!/usr/bin/env bash
# リリースの版上げコミット (HEAD) とタグを main へ push する (.github/workflows/release.yml の publish の job が使う)。
#
#   scripts/release-push.sh [--check-only] <tag> <base-sha>
#
# <base-sha> は run の開始時の main (github.sha)。HEAD はその上の版上げコミット1つだけであること。
# main が <base-sha> から進んでいたら rebase せずに止める (ビルド・デプロイしたソースと main の内容をずらさないため。
# 止まったら Release を最初から実行し直す)。push は --atomic で、main (fast-forward のみ) とタグの両方が入るか
# どちらも入らないかにする。--check-only は確認だけ行い、タグを作らず push もしない。
# origin は Deploy Key (main の ruleset を bypass できる) で push できる状態であること (actions/checkout の ssh-key)。
set -euo pipefail

check_only=0
if [ "${1:-}" = --check-only ]; then check_only=1; shift; fi
if [ $# -ne 2 ]; then
  echo "usage: $0 [--check-only] <tag> <base-sha>" >&2
  exit 2
fi
tag="$1" base="$2"

err() { echo "::error::$*" >&2; exit 1; }

[ "$(git rev-parse HEAD^)" = "$base" ] || err "HEAD の親が開始時の main ($base) でない"
git check-ref-format "refs/tags/$tag" || err "タグ名が不正: $tag"

remote_main="$(git ls-remote origin refs/heads/main | cut -f1)"
[ -n "$remote_main" ] || err "origin の main を読めない"
if [ "$remote_main" != "$base" ]; then
  err "実行中に main が進んだ ($base → $remote_main)。版上げを push しない。Actions > Release を main で実行し直す"
fi
if [ -n "$(git ls-remote --tags origin "refs/tags/$tag")" ]; then
  err "タグ $tag が既に origin にある"
fi
[ "$check_only" = 1 ] && { echo "push できる状態 (main=$base, $tag なし)"; exit 0; }

GIT_COMMITTER_NAME="github-actions[bot]" \
GIT_COMMITTER_EMAIL="41898282+github-actions[bot]@users.noreply.github.com" \
  git -c tag.gpgSign=false tag -a "$tag" -m "Release $tag" HEAD
# 注釈付きタグにする (軽量タグは --follow-tags で送られない。ここでは明示して送るが種類をそろえる)
if ! git push --atomic origin "HEAD:refs/heads/main" "refs/tags/$tag"; then
  err "push に失敗した (main が進んだ等)。rebase はしない。Actions > Release を main で実行し直す"
fi
echo "pushed: main=$(git rev-parse HEAD) tag=$tag"
