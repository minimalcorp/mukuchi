# shellcheck shell=bash
# stapler の通信断だけを再試行する (build-macos.sh・verify-macos.sh から source する。単体では実行しない)。
#
# stapler staple / validate は Apple (CloudKit) に票 (ticket) を問い合わせるが、その通信が確率的に切れて
# "Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."" →
# "CloudKit's response is inconsistent with expections" → "The staple and validate action failed! Error 68." で落ちる
# (GitHub Actions の macos-15 で頻発。成果物・公証の結果とは無関係)。
# Apple DTS は stapler の CloudKit への問い合わせの失敗をたいていクライアント側のネットワークが原因とし、
# 自動化ではやり直すよう勧めている (https://developer.apple.com/forums/thread/824494 ,
# https://developer.apple.com/forums/thread/728864)。CloudKit の文書も通信断 (CKError.serverResponseLost) は
# 冪等な操作なら再試行してよいとしている。staple は票を書き直すだけ、validate は読むだけで、どちらも冪等
#
# 再試行するのは出力に NSURLErrorDomain を含む失敗だけ。票が無い・一致しない等の失敗はこの文字列を含まず
# 1回で元の終了コードを返すため、検証は甘くならない。再試行し尽くしても通信断なら最後の終了コードで失敗する。
#
# CI では devShell 外 (macOS の /bin/bash 3.2) で動くため、bash 3.2 で使える構文だけを使う。

# retry_network <コマンド...>: コマンドを実行して出力 (stdout+stderr) を stdout に出す。成功なら 0。
# 失敗して出力に NSURLErrorDomain があり、残り回数があれば待ってやり直す。それ以外は元の終了コードを返す。
# 待ち時間 (秒) は MUKUCHI_STAPLER_RETRY_DELAYS (空白区切り。既定 "10 30" = 最大3回)。テストでは "0 0" にする。
# set -e の下でも失敗の終了コードはそのまま return する (呼び出し側の set -e で止まる)。
#
# 再試行の告知は fd 3 が開いていれば fd 3、無ければ stderr に出す。verify-macos.sh の check は出力 (2>&1) を
# 握って PASS 時に捨てるため、通って終わった時にも再試行したことがログに残るよう fd 3 (exec 3>&2) へ逃がす。
# fd 3 は呼び出し側で開く (make の jobserver 等、別の用途の fd 3 を受け継いでいる所では開いてから呼ぶ)
retry_network() {
  local delays="${MUKUCHI_STAPLER_RETRY_DELAYS:-10 30}" d a i total=1 attempt=1 out rc
  # 不正な値で sleep が落ちて「通信断ではない失敗」と見分けがつかなくならないよう先に弾く
  # shellcheck disable=SC2086 # 空白区切りの数を分けるため
  for d in $delays; do
    case "$d" in
      '' | *[!0-9]*) echo "retry_network: MUKUCHI_STAPLER_RETRY_DELAYS が不正 ($delays)" >&2; return 2 ;;
    esac
    total=$((total + 1))
  done
  while :; do
    rc=0
    out="$("$@" 2>&1)" || rc=$?
    if [ -n "$out" ]; then printf '%s\n' "$out"; fi
    if [ "$rc" -eq 0 ]; then return 0; fi
    if [ "$attempt" -ge "$total" ]; then return "$rc"; fi
    case "$out" in
      *NSURLErrorDomain*) ;;
      *) return "$rc" ;;
    esac
    # attempt 番目の待ち時間 (bash 3.2 は set -u の下で空配列の展開が落ちるため配列にしない)
    d="" i=0
    # shellcheck disable=SC2086
    for a in $delays; do
      i=$((i + 1))
      if [ "$i" -eq "$attempt" ]; then d="$a"; break; fi
    done
    attempt=$((attempt + 1))
    _retry_network_notice "retry_network: 通信が切れた (NSURLErrorDomain、終了コード $rc)。${d} 秒後にやり直す ($attempt/$total 回目): $*"
    sleep "$d"
  done
}

_retry_network_notice() {
  # fd 3 が閉じている・書き込めない (読み取り専用で受け継いだ等) なら stderr へ。告知の失敗で set -e により
  # 再試行せずに止まらないよう、書き込みの成否で判断する (bash 3.2 でも使える方法。/dev/fd は見ない)
  { printf '%s\n' "$1" >&3; } 2>/dev/null || printf '%s\n' "$1" >&2
}
