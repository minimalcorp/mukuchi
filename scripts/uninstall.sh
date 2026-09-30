#!/bin/bash
# mukuchi を完全にアンインストールする (アプリ内の「完全にアンインストール」を使えない場合用)。
# 対象は docs/architecture.md「識別子・パス」のアンインストール対象と揃える。
# macOS 標準の /bin/bash (3.2) で動くように書く (利用者の環境に依存しないため)。
set -euo pipefail

usage() {
  cat <<'EOF'
使い方: uninstall.sh [--dev] [--dry-run] [--yes] [--app <path>]
  --dev        開発版 (com.minimalcorp.mukuchi.dev) を対象にする
  --dry-run    削除対象と実行内容を表示するだけで何も変更しない
  --yes        確認せずに実行する
  --app <path> アプリ本体の場所を指定する (既定: 起動中のもの、なければ /Applications と ~/Applications から探す)

削除するもの: データ (実行環境・モデル・設定)、キャッシュ・ログ・WebKit データ、環境設定、
TCC の許可 (マイク・アクセシビリティ)。アプリ本体はゴミ箱へ移す。
ログイン項目はスクリプトから解除できない (下記の表示に従う)。
EOF
}

id=com.minimalcorp.mukuchi
dev=0
dry=0
yes=0
app=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dev) dev=1; id=com.minimalcorp.mukuchi.dev ;;
    --dry-run|-n) dry=1 ;;
    --yes|-y) yes=1 ;;
    --app) [ $# -ge 2 ] || { usage >&2; exit 2; }; app="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "不明な引数: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

lib="$HOME/Library"

# HOME が利用者の本来のホームでない場合 (テストで一時ディレクトリを HOME にした時) は、
# HOME と無関係に実機へ作用する操作 (プロセス停止・TCC・cfprefsd) を行わない
real_home="$(/usr/bin/dscl . -read "/Users/$(/usr/bin/id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
system_ops=1
if [ -z "$real_home" ] || [ "$(cd "$HOME" && pwd -P)" != "$(cd "$real_home" 2>/dev/null && pwd -P)" ]; then
  system_ops=0
fi

bundle_id_of() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$1/Contents/Info.plist" 2>/dev/null || true
}

running_pids() {
  [ "$system_ops" = 1 ] || return 0
  local asn
  for asn in $(/usr/bin/lsappinfo find "bundleid=$id" 2>/dev/null); do
    /usr/bin/lsappinfo info -only pid "$asn" 2>/dev/null | sed -n 's/^"pid"=//p'
  done
}

# --- アプリ本体の場所 ---
if [ -z "$app" ]; then
  for pid in $(running_pids); do
    p="$(/usr/bin/lsappinfo info -only bundlepath "$(/usr/bin/lsappinfo find "pid=$pid")" 2>/dev/null | sed -n 's/^"LSBundlePath"="\(.*\)"$/\1/p')"
    if [ -n "$p" ]; then app="$p"; break; fi
  done
fi
if [ -z "$app" ]; then
  for p in /Applications/*.app "$HOME"/Applications/*.app; do
    [ -d "$p" ] || continue
    if [ "$(bundle_id_of "$p")" = "$id" ]; then app="$p"; break; fi
  done
fi
if [ -n "$app" ]; then
  app="${app%/}"
  got="$(bundle_id_of "$app")"
  if [ "$got" != "$id" ]; then
    echo "error: $app のバンドルID ($got) が $id ではない" >&2
    exit 1
  fi
fi

# --- 削除対象 (存在するものだけ) ---
candidates=(
  "$lib/Application Support/$id"
  "$lib/Caches/$id"
  "$lib/Logs/$id"
  "$lib/WebKit/$id"
  "$lib/HTTPStorages/$id"
  "$lib/Saved Application State/$id.savedState"
  "$lib/Preferences/$id.plist"
)
if [ "$dev" = 1 ]; then
  # tauri dev はバンドルせずに実行するため、WebKit が実行ファイル名で作る
  candidates+=("$lib/Caches/mukuchi" "$lib/WebKit/mukuchi")
fi
targets=()
for p in "${candidates[@]}"; do
  if [ -e "$p" ] || [ -L "$p" ]; then targets+=("$p"); fi
done

size_of() { du -sh "$1" 2>/dev/null | awk '{print $1}'; }

echo "対象: $id"
[ "$system_ops" = 1 ] || echo "(HOME=$HOME は本来のホームではないため、プロセス停止・TCC・環境設定デーモンの操作は行わない)"
echo
echo "削除するファイル:"
if [ ${#targets[@]} -eq 0 ]; then
  echo "  (なし)"
else
  for p in ${targets[@]+"${targets[@]}"}; do printf '  %6s  %s\n' "$(size_of "$p")" "$p"; done
fi
echo "ゴミ箱へ移すアプリ:"
if [ -n "$app" ]; then printf '  %6s  %s\n' "$(size_of "$app")" "$app"; else echo "  (見つからない)"; fi
pids="$(running_pids | tr '\n' ' ')"
echo "終了するプロセス: ${pids:-(起動していない)}"
echo "TCC の許可をリセット: tccutil reset All $id"
echo

if [ "$dry" = 1 ]; then
  echo "--dry-run: 何も変更していない"
  exit 0
fi
if [ ${#targets[@]} -eq 0 ] && [ -z "$app" ] && [ -z "$pids" ]; then
  echo "削除するものがない"
  exit 0
fi
if [ "$yes" != 1 ]; then
  printf '実行しますか? [y/N] '
  read -r ans </dev/tty || ans=""
  case "$ans" in y|Y|yes) ;; *) echo "中止した"; exit 1 ;; esac
fi

# 1. 起動中のアプリを終了する (ASR サーバーは stdin の EOF で自分で終了する)。
#    AppleScript の quit は「オートメーション」の許可を求めるため使わず、シグナルで止める
if [ -n "$pids" ]; then
  echo "==> アプリを終了"
  # $pids・$alive は空白区切りの PID 列なので分割させる
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true
  for _ in $(seq 1 20); do
    alive=""; for p in $pids; do kill -0 "$p" 2>/dev/null && alive="$alive $p"; done
    [ -z "$alive" ] && break
    sleep 0.25
  done
  # shellcheck disable=SC2086
  [ -n "${alive:-}" ] && kill -KILL $alive 2>/dev/null || true
fi
if [ "$system_ops" = 1 ]; then
  # アプリが異常終了して残った ASR サーバー (データディレクトリの venv の python)
  pkill -f "$lib/Application Support/$id/venv/bin/python" 2>/dev/null || true
fi

# 2. TCC。LaunchServices に登録されたアプリがないと失敗するため、本体をゴミ箱へ移す前に行う
if [ "$system_ops" = 1 ]; then
  echo "==> TCC の許可をリセット"
  /usr/bin/tccutil reset All "$id" || echo "  警告: リセットできなかった (アプリ本体がない場合は システム設定 > プライバシーとセキュリティ から削除する)"
fi

# 3. 環境設定。ファイルを消すだけでは cfprefsd のキャッシュから書き戻されることがあるため defaults で消す
if [ "$system_ops" = 1 ]; then
  /usr/bin/defaults delete "$id" >/dev/null 2>&1 || true
fi

# 4. ファイル (bash 3.2 は set -u で空配列の展開をエラーにするため +形式で展開する)
for p in ${targets[@]+"${targets[@]}"}; do
  echo "==> 削除: $p"
  rm -rf "$p"
done

# 5. アプリ本体 (ゴミ箱へ。取り消せるように完全削除はしない)
if [ -n "$app" ]; then
  echo "==> ゴミ箱へ移動: $app"
  # trash コマンドは HOME ではなく実際の利用者のゴミ箱に移すため、テスト時 (system_ops=0) は使わない
  if [ "$system_ops" = 1 ] && [ -x /usr/bin/trash ]; then
    /usr/bin/trash -s "$app"
  else
    # macOS 14 以前には trash コマンドがない
    mkdir -p "$HOME/.Trash"
    dest="$HOME/.Trash/$(basename "$app")"
    [ -e "$dest" ] && dest="$HOME/.Trash/$(basename "$app" .app) $(date +%Y%m%d-%H%M%S).app"
    mv "$app" "$dest"
  fi
fi

# 6. ログイン項目。SMAppService.mainApp で登録した項目は Background Task Management に記録され、
#    解除する API はアプリ自身からしか呼べない (sfltool resetbtm は他のアプリの項目も消すため使わない)
cat <<'EOF'

完了。
ログイン項目に mukuchi が残っている場合は「システム設定 > 一般 > ログイン項目と機能拡張」から削除してください。
(アプリ内の「完全にアンインストール」を使った場合は自動で解除されます)
EOF
