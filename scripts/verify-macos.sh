#!/usr/bin/env bash
# 配布物の検証 (make verify)。make build / make build-local の最後にも呼ばれる。
#
# .app の署名を見てモードを決める:
#   Developer ID … 全項目を検証する (spctl・staple を含む)。.dmg も必須
#   ad-hoc       … Gatekeeper (spctl)・公証 (stapler) は通らないのが正しいため SKIP と表示する。.dmg は無ければ SKIP
# 1つでも FAIL があれば終了コード 1。
# pass は常に成功するため `条件 && pass || fail` で fail が誤って走ることはない
# shellcheck disable=SC2015
set -uo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
TARGET=aarch64-apple-darwin
BUNDLE_DIR="$root/src-tauri/target/$TARGET/release/bundle"
APP="${MUKUCHI_VERIFY_APP:-$BUNDLE_DIR/macos/mukuchi.app}"
BUNDLE_ID=com.minimalcorp.mukuchi
MIN_MACOS=13.0
# 同梱 uv の署名者。fetch-uv.sh の sha256 固定に加え、開発元の署名のまま同梱されていることを確かめる。
# uv の版を上げて署名者が変わった場合は codesign -dvv で確認して更新する
# (0.12.17 は "Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)")
UV_TEAM_ID=2DC432GLL2
# 付けてよい entitlements (Entitlements.plist と同じ)。増やす時は両方を直す
EXPECTED_ENTITLEMENTS='{"com.apple.security.device.audio-input":true}'

hostxcrun() { env -u DEVELOPER_DIR -u SDKROOT /usr/bin/xcrun "$@"; }

npass=0 nfail=0 nskip=0
pass() { echo "  PASS  $*"; npass=$((npass + 1)); }
fail() { echo "  FAIL  $*"; nfail=$((nfail + 1)); }
skip() { echo "  SKIP  $*"; nskip=$((nskip + 1)); }
# check <説明> <コマンド...>: 成功なら PASS、失敗なら出力を付けて FAIL
check() {
  local desc="$1" out; shift
  if out="$("$@" 2>&1)"; then pass "$desc"; else fail "$desc"; printf '%s\n' "$out" | sed 's/^/        /'; fi
}

[ -d "$APP" ] || { echo "error: $APP がない (make build / make build-local を先に実行)"; exit 1; }

sig="$(/usr/bin/codesign -dvv "$APP" 2>&1 || true)"
if grep -q '^Signature=adhoc' <<<"$sig"; then
  mode=adhoc
elif grep -q '^Authority=Developer ID Application:' <<<"$sig"; then
  mode=devid
else
  echo "error: $APP が署名されていないか、Developer ID でも ad-hoc でもない署名:"; printf '%s\n' "$sig"; exit 1
fi
echo "verify: $APP ($mode)"

# ---- .app ---------------------------------------------------------------------------------------

check "codesign --verify --deep --strict" /usr/bin/codesign --verify --deep --strict --verbose=2 "$APP"

grep -q 'flags=0x[0-9a-f]*([^)]*runtime' <<<"$sig" && pass "Hardened Runtime" || fail "Hardened Runtime (flags に runtime がない)"

if [ "$mode" = devid ]; then
  grep -q '^Timestamp=' <<<"$sig" && pass "secure timestamp" || fail "secure timestamp がない (Signed Time のみ)"
  grep -q '^TeamIdentifier=[A-Z0-9]\{10\}$' <<<"$sig" && pass "TeamIdentifier ($(sed -n 's/^TeamIdentifier=//p' <<<"$sig"))" || fail "TeamIdentifier"
else
  skip "secure timestamp / TeamIdentifier (ad-hoc 署名には付かない)"
fi

ents="$(/usr/bin/codesign -d --entitlements - --xml "$APP" 2>/dev/null | /usr/bin/plutil -convert json -o - - 2>/dev/null || echo '{}')"
if [ "$(python3 -c 'import json,sys; print(json.loads(sys.argv[1]) == json.loads(sys.argv[2]))' "$ents" "$EXPECTED_ENTITLEMENTS")" = True ]; then
  pass "entitlements = $EXPECTED_ENTITLEMENTS"
else
  fail "entitlements が想定と違う: $ents (想定 $EXPECTED_ENTITLEMENTS)"
fi

plist="$APP/Contents/Info.plist"
pb() { /usr/libexec/PlistBuddy -c "Print :$1" "$plist" 2>/dev/null; }
[ "$(pb CFBundleIdentifier)" = "$BUNDLE_ID" ] && pass "CFBundleIdentifier = $BUNDLE_ID" || fail "CFBundleIdentifier = $(pb CFBundleIdentifier) (想定 $BUNDLE_ID)"
[ "$(pb LSMinimumSystemVersion)" = "$MIN_MACOS" ] && pass "LSMinimumSystemVersion = $MIN_MACOS" || fail "LSMinimumSystemVersion = $(pb LSMinimumSystemVersion) (想定 $MIN_MACOS)"
[ -n "$(pb NSMicrophoneUsageDescription)" ] && pass "NSMicrophoneUsageDescription" || fail "NSMicrophoneUsageDescription がない"

# 配布物が /nix/store にリンクしていると他の Mac で起動しない
nix_links=""
while IFS= read -r -d '' f; do
  case "$(/usr/bin/file -b "$f")" in *Mach-O*) ;; *) continue ;; esac
  l="$(/usr/bin/otool -L "$f" | grep /nix/store || true)"
  [ -n "$l" ] && nix_links+="$f:"$'\n'"$l"$'\n'
done < <(find "$APP" -type f -print0)
[ -z "$nix_links" ] && pass "/nix/store へのリンクなし" || { fail "/nix/store にリンクしている"; printf '%s' "$nix_links" | sed 's/^/        /'; }

# 同梱 uv: Contents/Helpers (Apple の "Placing content in a bundle" で helper tool の置き場所)。
# Resources にコードを置くと公証で問題になりうるため、Mach-O が Resources 等に紛れていないことも確かめる
uv="$APP/Contents/Helpers/uv"
if [ -x "$uv" ]; then
  uvsig="$(/usr/bin/codesign -dvv "$uv" 2>&1)"
  check "uv: codesign --verify --strict" /usr/bin/codesign --verify --strict "$uv"
  grep -q "^TeamIdentifier=$UV_TEAM_ID\$" <<<"$uvsig" && grep -q '^Authority=Developer ID Application:' <<<"$uvsig" \
    && pass "uv: 開発元の Developer ID 署名 ($UV_TEAM_ID)" || { fail "uv: 署名者が想定 ($UV_TEAM_ID) と違う"; grep -E '^(Authority|TeamIdentifier)=' <<<"$uvsig" | sed 's/^/        /'; }
  grep -q 'flags=0x[0-9a-f]*([^)]*runtime' <<<"$uvsig" && grep -q '^Timestamp=' <<<"$uvsig" \
    && pass "uv: Hardened Runtime + secure timestamp" || fail "uv: Hardened Runtime / secure timestamp がない"
else
  fail "uv: $uv がない・実行できない"
fi
# 本体が実際に解決する uv が同梱の Helpers/uv であること (パス解決の退行で開発用の uv や Resource を指さないように)。
# ビルドした本体を実行するため、CI では資格情報を片付けた後に呼ぶ (release.yml)。
# MUKUCHI_DEV_UV はデバッグビルドでしか効かないが、念のため外す
exe="$APP/Contents/MacOS/mukuchi"
if out="$(env -u MUKUCHI_DEV_UV "$exe" --print-uv-path 2>&1)"; then
  real() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }
  got="$(real "$out")"; want="$(real "$uv")"
  [ "$got" = "$want" ] && pass "mukuchi --print-uv-path = Contents/Helpers/uv" || fail "mukuchi --print-uv-path = $out (想定 $want)"
else
  fail "mukuchi --print-uv-path が失敗"; printf '%s\n' "$out" | sed 's/^/        /'
fi
stray=""
while IFS= read -r -d '' f; do
  case "$f" in "$APP/Contents/MacOS/"*|"$APP/Contents/Helpers/"*) continue ;; esac
  case "$(/usr/bin/file -b "$f")" in *Mach-O*) stray+="$f"$'\n' ;; esac
done < <(find "$APP" -type f -print0)
[ -z "$stray" ] && pass "MacOS/・Helpers/ 以外に Mach-O なし" || { fail "MacOS/・Helpers/ 以外に Mach-O がある"; printf '%s' "$stray" | sed 's/^/        /'; }

if [ "$mode" = devid ]; then
  out="$(/usr/sbin/spctl -a -vv -t exec "$APP" 2>&1)"
  if grep -q ': accepted' <<<"$out" && grep -q 'source=Notarized Developer ID' <<<"$out"; then
    pass "spctl -t exec (Notarized Developer ID)"
  else
    fail "spctl -t exec"; printf '%s\n' "$out" | sed 's/^/        /'
  fi
  check "stapler validate (.app)" hostxcrun stapler validate "$APP"
else
  skip "spctl -t exec (ad-hoc は Gatekeeper に拒否されるのが正しい)"
  skip "stapler validate (.app) (ad-hoc は公証しない)"
fi

# ---- .dmg ---------------------------------------------------------------------------------------

dmg=""
for f in "$BUNDLE_DIR"/dmg/*.dmg; do [ -f "$f" ] && { dmg="$f"; break; }; done
if [ -z "$dmg" ]; then
  if [ "$mode" = devid ]; then fail ".dmg がない ($BUNDLE_DIR/dmg/)"; else skip ".dmg の検証 (make build-local は .dmg を作らない)"; fi
else
  echo "verify: $dmg"
  dsig="$(/usr/bin/codesign -dvv "$dmg" 2>&1 || true)"
  check "dmg: codesign --verify --strict" /usr/bin/codesign --verify --strict --verbose=2 "$dmg"
  grep -q '^Authority=Developer ID Application:' <<<"$dsig" && grep -q '^Timestamp=' <<<"$dsig" \
    && pass "dmg: Developer ID 署名 + secure timestamp" || fail "dmg: Developer ID 署名 / secure timestamp がない"
  out="$(/usr/sbin/spctl -a -vv -t open --context context:primary-signature "$dmg" 2>&1)"
  if grep -q ': accepted' <<<"$out" && grep -q 'source=Notarized Developer ID' <<<"$out"; then
    pass "dmg: spctl -t open (Notarized Developer ID)"
  else
    fail "dmg: spctl -t open"; printf '%s\n' "$out" | sed 's/^/        /'
  fi
  check "dmg: stapler validate" hostxcrun stapler validate "$dmg"

  # 中の .app が今回の .app と同じ署名・staple 済みであること (古い dmg の取り違え防止)。
  # Finder に表示しないよう -nobrowse、書き込まないよう -readonly で一時ディレクトリに繋ぐ
  mnt="$(mktemp -d)"
  if /usr/bin/hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$dmg" >/dev/null; then
    inner="$mnt/mukuchi.app"
    check "dmg: 中の .app の codesign --verify --deep --strict" /usr/bin/codesign --verify --deep --strict "$inner"
    a="$(/usr/bin/codesign -dvvv "$APP" 2>&1 | grep '^CDHash=')"; b="$(/usr/bin/codesign -dvvv "$inner" 2>&1 | grep '^CDHash=')"
    [ -n "$a" ] && [ "$a" = "$b" ] && pass "dmg: 中の .app = $APP ($a)" || fail "dmg: 中の .app が $APP と違う ($b / $a)"
    check "dmg: 中の .app の stapler validate" hostxcrun stapler validate "$inner"
    [ -L "$mnt/Applications" ] && pass "dmg: Applications へのリンク" || fail "dmg: Applications へのリンクがない"
    /usr/bin/hdiutil detach -quiet "$mnt" || /usr/bin/hdiutil detach -force -quiet "$mnt"
  else
    fail "dmg: hdiutil attach できない"
  fi
  rmdir "$mnt" 2>/dev/null || true
fi

echo "verify: PASS $npass / FAIL $nfail / SKIP $nskip ($mode)"
[ "$mode" = adhoc ] && echo "  ad-hoc 署名のため Gatekeeper・公証の項目は SKIP。配布物は make build で作る"
[ "$nfail" -eq 0 ]
