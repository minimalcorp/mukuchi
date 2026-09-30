#!/usr/bin/env bash
# 開発版 (com.minimalcorp.mukuchi.dev) の状態を消し、次回の起動を初回起動と同じにする。make reset から呼ぶ。
# モデル (models/, 約4GB) は常に残す。導入済みの記録 (provisioned.json) は PROVISION=1、
# 実行環境 (python・venv・uv・cache・asr-server) は ALL=1 の時だけ消す (ALL=1 は記録も消す)。
# PERMISSIONS=1 で dev のバンドルIDの TCC もリセットする。
# 消す対象は docs/architecture.md「識別子・パス」のアンインストール対象のうち dev のもの (ログは残す)。
set -euo pipefail

id=com.minimalcorp.mukuchi.dev
# tauri dev の未バンドル実行で WebKit が実行ファイル名で作る場所 (src-tauri/src/core.rs DEV_PRODUCT_NAME)
dev_exe=mukuchi
lib="$HOME/Library"
# MUKUCHI_DEV_DATA は使わず HOME から決める (上書きされていても ~/Library の dev の場所以外を消さないため)
data="$lib/Application Support/$id"

# HOME が本来のホームでない場合 (テストで一時ディレクトリを HOME にした時) は、HOME と無関係に実機へ作用する TCC を操作しない
real_home="$(/usr/bin/dscl . -read "/Users/$(/usr/bin/id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
system_ops=1
if [ -z "$real_home" ] || [ "$(cd "$HOME" && pwd -P)" != "$(cd "$real_home" 2>/dev/null && pwd -P)" ]; then
  system_ops=0
fi

removed=0
remove() {
  local p="$1"
  [ -e "$p" ] || [ -L "$p" ] || return 0
  # 念のため: ~/Library 配下で、名前に dev のバンドルID (または dev の実行ファイル名) を含むものだけ
  case "$p" in
    "$lib"/*) ;;
    *) echo "error: ~/Library 外のため消さない: $p" >&2; exit 1 ;;
  esac
  case "$p" in
    *"$id"*|*/"$dev_exe") ;;
    *) echo "error: dev のバンドルIDを含まないため消さない: $p" >&2; exit 1 ;;
  esac
  printf '  %6s  %s\n' "$(du -sh "$p" 2>/dev/null | awk '{print $1}')" "$p"
  rm -rf "$p"
  removed=$((removed + 1))
}

echo "==> reset: $id (models/ は残す)"

# データディレクトリ内: mukuchi が作った目印があるときだけ触る
if [ -d "$data" ]; then
  if [ -f "$data/.mukuchi-data" ] && [ ! -e "$data/.git" ]; then
    remove "$data/settings.json"
    remove "$data/settings.json.tmp"
    # 導入済みの記録を残すと、セットアップの「ダウンロード」画面は完了済みで表示され待たされない。
    # ダウンロード・導入の流れ自体を確かめる時だけ PROVISION=1 (または ALL=1) で消す
    if [ "${PROVISION:-}" = 1 ] || [ "${ALL:-}" = 1 ]; then
      remove "$data/provisioned.json"
      remove "$data/provisioned.json.tmp"
    fi
    if [ "${ALL:-}" = 1 ]; then
      for d in python venv uv cache asr-server; do remove "$data/$d"; done
    fi
  else
    echo "  skip: 目印 (.mukuchi-data) がないためデータディレクトリには触らない: $data"
  fi
fi

# WebKit・AppKit がバンドルID (未バンドル実行では実行ファイル名) で作るもの
for p in \
  "$lib/Caches/$id" "$lib/Caches/$dev_exe" \
  "$lib/WebKit/$id" "$lib/WebKit/$dev_exe" \
  "$lib/HTTPStorages/$id" "$lib/HTTPStorages/$id.binarycookies" \
  "$lib/Saved Application State/$id.savedState"; do
  remove "$p"
done

[ "$removed" -gt 0 ] || echo "  (削除するものなし)"
[ -d "$data/models" ] && echo "  kept: $data/models"
if [ "${PROVISION:-}" != 1 ] && [ "${ALL:-}" != 1 ]; then
  echo "  kept: 導入済みの記録 (provisioned.json)。セットアップのダウンロードからやり直すなら PROVISION=1"
fi
if [ "${ALL:-}" != 1 ]; then
  echo "  kept: 実行環境 (python・venv・uv・cache・asr-server)。消すなら ALL=1"
fi

if [ "${PERMISSIONS:-}" = 1 ]; then
  echo "==> 権限"
  cat <<'EOF'
  tauri dev の未バンドル実行では、マイク・アクセシビリティの許可はアプリではなく起動元の
  ターミナル (Terminal / iTerm2 / VS Code 等) に帰属する。ターミナルの許可は他の作業に影響するため自動では消さない。
  取り消す場合は「システム設定 > プライバシーとセキュリティ」から手動で外す。
EOF
  if [ "$system_ops" = 1 ]; then
    /usr/bin/tccutil reset All "$id" || echo "  警告: tccutil reset が失敗した (LaunchServices に dev の .app が登録されていない場合は失敗する。影響なし)"
  else
    echo "  skip: HOME=$HOME は本来のホームではないため tccutil を実行しない"
  fi
fi
