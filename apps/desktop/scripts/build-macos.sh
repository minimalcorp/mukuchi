#!/usr/bin/env bash
# 配布用ビルド。make build / make build-local から devShell 内で呼ばれる。
#
#   scripts/build-macos.sh               Developer ID 署名 + Hardened Runtime + 公証 + staple の .dmg (make build)。
#                                        --build-only と --sign-only を続けて行い、最後に make verify 相当
#   scripts/build-macos.sh --local       ad-hoc 署名の .app (make build-local。公証しない)
#   scripts/build-macos.sh --local-dmg   --local に加えて .dmg も作る (make dmg-local。ウィンドウの見た目の確認用。
#                                        .dmg は署名・公証しない)
#   scripts/build-macos.sh --build-only  署名なしの .app と .dmg のテンプレートを作るだけ (資格情報を見ない・要らない)
#   scripts/build-macos.sh --sign-only   既存の .app を署名 → 公証・staple → テンプレートに入れて .dmg 作成・署名 → 公証・staple。
#                                        Apple のツール (codesign/notarytool/stapler/hdiutil) と標準ライブラリだけの
#                                        python3 (check-dmg-layout.py) だけを使い、npm・cargo・uv の依存・ビルドした本体を
#                                        実行しない。検証は呼び出し側で行う
#
# build と sign を分ける理由: npm・cargo の依存 (postinstall・build.rs 等の第三者のコード) を資格情報がある場所で
# 動かさないため。CI (release.yml) では別 job にし、署名 job は依存を入れずに .app だけを受け取る。
# 検証 (verify-macos.sh) はビルドした本体を実行するため、CI では資格情報を片付けてから行う。
#
# 手順 (既定): 資格情報の確認 (公証の前に長いビルドをしないため最初に) → tauri build --no-sign で .app →
#       codesign → .app を公証・staple → .app を入れた .dmg を作成・署名 → .dmg を公証・staple → make verify 相当
#
# 署名・公証を Tauri に任せない理由 (tauri-cli 2.12.0 / tauri-bundler 2.10.0 / tauri-macos-sign 2.4.0 のソースで確認):
#   - 公証の資格情報は APPLE_ID/APPLE_PASSWORD か APPLE_API_KEY* のみで、notarytool のキーチェーンプロファイルに対応しない
#   - PATH の xcrun を呼ぶため、devShell では nixpkgs の xcbuild 版 xcrun になり notarytool が見つからない
#   - staple の失敗を検査しない。entitlements を externalBin にも付ける。codesign に --timestamp を明示しない
#   - Tauri の dmg は staple 前の .app を入れることができない (dmg だけの bundle でも .app を作り直す) ため、
#     .dmg は自前で作る
#
# .dmg の見た目 (背景・アイコン位置・ボリュームアイコン): ビルド側で dmgbuild (scripts/run-dmgbuild.py、
# scripts/dmg-settings.py) が .app を含まないテンプレート (UDRW) を作る。dmgbuild は Finder・AppleScript を使わず
# .DS_Store を直接書くため画面に何も出ない。署名側は staple 済みの .app を hdiutil・ditto でテンプレートに入れて
# UDZO に変換するだけにする (第三者のコードである dmgbuild を資格情報のある所で動かさないため)。
# hdiutil convert は同じ HFS+ ボリュームをそのまま写すので、.DS_Store 内の背景のエイリアスは有効なまま
#
# 資格情報 (リポジトリに置かない):
#   署名: APPLE_SIGNING_IDENTITY (証明書名の一部か SHA-1。未設定ならキーチェーン内の "Developer ID Application" が
#         ちょうど1つならそれを使う)。codesign には SHA-1 を渡す (同名の証明書が複数あっても曖昧にならないため)
#   公証: APPLE_API_KEY + APPLE_API_ISSUER + APPLE_API_KEY_PATH (App Store Connect API キー) があればそれ、
#         なければ notarytool のキーチェーンプロファイル MUKUCHI_NOTARY_PROFILE (既定 mukuchi)。
#         ~/.config/mukuchi/notary.env があれば読み込む (未設定の変数だけ上記の変数を設定するファイル)
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

mode=release
case "${1:-}" in
  --local) mode=local ;;
  --local-dmg) mode=local-dmg ;;
  --build-only) mode=build-only ;;
  --sign-only) mode=sign-only ;;
  "") ;;
  *) echo "usage: $0 [--local | --local-dmg | --build-only | --sign-only]" >&2; exit 2 ;;
esac

TARGET=aarch64-apple-darwin
BUNDLE_DIR="$root/src-tauri/target/$TARGET/release/bundle"
APP="$BUNDLE_DIR/macos/mukuchi.app"
ENTITLEMENTS="$root/src-tauri/Entitlements.plist"
# .app を入れる前の .dmg (見た目だけを持つ UDRW)。CI では .app と一緒に build job から sign job へ渡す
DMG_TEMPLATE="$BUNDLE_DIR/dmg-template/mukuchi.dmg"

die() { echo "error: $*" >&2; exit 1; }
step() { echo "==> $*"; }

# devShell は DEVELOPER_DIR/SDKROOT を nixpkgs の SDK に向け、PATH の xcrun も xcbuild 版にする。
# notarytool・stapler はホストの Xcode (または Command Line Tools) にしかないため外して呼ぶ
hostxcrun() { env -u DEVELOPER_DIR -u SDKROOT /usr/bin/xcrun "$@"; }

# ---- 資格情報の確認 (release のみ) --------------------------------------------------------------

identity=""
notary_args=()

# identity (codesign に渡す SHA-1) と identity_name (表示用) を決める
identity_name=""
resolve_identity() {
  local all cands n
  all="$(/usr/bin/security find-identity -v -p codesigning)"
  # "  1) <SHA-1 40桁> "Developer ID Application: ..."" → "<SHA-1> <名前>"。同じ証明書が複数のキーチェーンにあると重複するため sort -u
  cands="$(sed -n 's/^ *[0-9]*) \([0-9A-F]\{40\}\) "\(Developer ID Application: .*\)"$/\1 \2/p' <<<"$all" | sort -u)"
  if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
    cands="$(grep -iF -- "$APPLE_SIGNING_IDENTITY" <<<"$cands" || true)"
  fi
  n="$(printf '%s' "$cands" | grep -c . || true)"
  case "$n" in
    1) identity="${cands%% *}"; identity_name="${cands#* }" ;;
    0)
      if [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
        die "APPLE_SIGNING_IDENTITY=\"$APPLE_SIGNING_IDENTITY\" に一致する有効な Developer ID Application 証明書がキーチェーンにない
  確認: security find-identity -v -p codesigning"
      fi
      die "Developer ID Application 証明書がキーチェーンにない (security find-identity -v -p codesigning)。
  証明書の作成・読み込み手順は docs/release.md を参照。ad-hoc 署名で確かめるだけなら make build-local" ;;
    *) die "Developer ID Application 証明書が複数ある。APPLE_SIGNING_IDENTITY に SHA-1 を指定する:
$(printf '%s\n' "$cands" | sed 's/^/  /')" ;;
  esac
}

resolve_notary() {
  local envfile="$HOME/.config/mukuchi/notary.env"
  if [ -f "$envfile" ]; then
    # 環境変数で指定済みのものを優先する (CI・一時的な切り替え)
    local k v
    for k in APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH MUKUCHI_NOTARY_PROFILE; do
      [ -n "${!k:-}" ] && continue
      # shellcheck disable=SC1090
      v="$(set +u; . "$envfile" >/dev/null 2>&1; printf '%s' "${!k:-}")"
      [ -n "$v" ] && export "$k=$v"
    done
  fi

  if [ -n "${APPLE_API_KEY:-}${APPLE_API_ISSUER:-}${APPLE_API_KEY_PATH:-}" ]; then
    [ -n "${APPLE_API_KEY:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ] && [ -n "${APPLE_API_KEY_PATH:-}" ] \
      || die "App Store Connect API キーで公証するには APPLE_API_KEY (キーID)・APPLE_API_ISSUER (Issuer ID)・APPLE_API_KEY_PATH (.p8 のパス) の3つすべてが必要"
    [ -r "$APPLE_API_KEY_PATH" ] || die "APPLE_API_KEY_PATH のファイルが読めない: $APPLE_API_KEY_PATH"
    notary_args=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER")
    echo "notary: App Store Connect API キー ($APPLE_API_KEY)"
  else
    local profile="${MUKUCHI_NOTARY_PROFILE:-mukuchi}"
    notary_args=(--keychain-profile "$profile")
    echo "notary: キーチェーンプロファイル \"$profile\""
  fi
  # 資格情報が有効かを先に確かめる (通信する。ビルド後に失敗すると時間を無駄にするため)
  if ! hostxcrun notarytool history "${notary_args[@]}" >/dev/null 2>&1; then
    die "公証の資格情報を使えない (xcrun notarytool history が失敗)。
  キーチェーンプロファイルを使う場合: xcrun notarytool store-credentials ${MUKUCHI_NOTARY_PROFILE:-mukuchi} --key <AuthKey_XXXX.p8> --key-id <キーID> --issuer <Issuer ID>
  API キーを使う場合: APPLE_API_KEY / APPLE_API_ISSUER / APPLE_API_KEY_PATH を設定する (~/.config/mukuchi/notary.env でも可)
  詳細は docs/release.md。通信できない環境でも失敗する"
  fi
}

# node_modules が無いと tauri build が分かりにくいエラーで止まるため先に確かめる
if [ "$mode" != sign-only ] && [ ! -x node_modules/.bin/tauri ]; then
  die "node_modules/.bin/tauri がない。先に npm ci (CI) か make setup (手元) を実行する"
fi

if [ "$mode" = release ] || [ "$mode" = sign-only ]; then
  step "preflight"
  if ! { hostxcrun --find notarytool && hostxcrun --find stapler; } >/dev/null 2>&1; then
    die "notarytool / stapler が見つからない。Xcode か Command Line Tools (xcode-select --install) を入れる"
  fi
  resolve_identity
  echo "identity: $identity_name ($identity)"
  resolve_notary
fi

# ---- .app のビルド -----------------------------------------------------------------------------

if [ "$mode" != sign-only ]; then
  scripts/prepare-bundle-resources.sh

  step "tauri build (.app, 署名なし)"
  # 署名は下で自前で行う。Tauri が公証を試みないよう (--no-sign で署名ごと飛ばすが念のため) 資格情報を渡さない
  env -u APPLE_CERTIFICATE -u APPLE_CERTIFICATE_PASSWORD -u APPLE_SIGNING_IDENTITY \
      -u APPLE_ID -u APPLE_PASSWORD -u APPLE_TEAM_ID -u APPLE_API_KEY -u APPLE_API_ISSUER -u APPLE_API_KEY_PATH \
    npm run tauri build -- --target "$TARGET" --bundles app --no-sign

  [ -d "$APP" ] || die "$APP ができていない"
  # 前回の .dmg は古い .app を含むため消す (make verify が今回の .app と食い違う dmg を検証しないように)
  rm -rf "$BUNDLE_DIR/dmg"
fi

# ---- .dmg のテンプレート (ビルド側) ---------------------------------------------------------------

# mnt_attach <image> <mountpoint> [hdiutil attach の追加引数...]: Finder に表示せず (-nobrowse) 一時ディレクトリに繋ぐ
mnt_attach() {
  local img="$1" mnt="$2"; shift 2
  /usr/bin/hdiutil attach -nobrowse -noautoopen -mountpoint "$mnt" "$@" "$img" >/dev/null
}
mnt_detach() { /usr/bin/hdiutil detach -quiet "$1" || /usr/bin/hdiutil detach -force -quiet "$1"; }

make_dmg_template() {
  local tmp bg ok=0
  step "dmg template (dmgbuild)"
  tmp="$(mktemp -d)"
  # Retina 用に 1x と 2x を1つの TIFF にまとめる (Finder は背景に複数解像度の TIFF を使える)。
  # -cathidpicheck は 2x がちょうど2倍の大きさかも確かめる。dmgbuild にも @2x を探して同じことをする機能があるが、
  # 同じディレクトリの他のファイルを拾わないよう自前でまとめて --no-hidpi で渡す
  bg="$tmp/background.tiff"
  /usr/bin/tiffutil -cathidpicheck "$root/assets/brand/dmg/background.png" "$root/assets/brand/dmg/background@2x.png" -out "$bg" >/dev/null
  rm -rf "$(dirname "$DMG_TEMPLATE")"
  mkdir -p "$(dirname "$DMG_TEMPLATE")"
  # dmgbuild は /usr/bin/hdiutil・SetFile (ボリュームアイコンの属性) を呼ぶ。SetFile は xcrun 経由のため
  # devShell の DEVELOPER_DIR (nixpkgs の SDK) を外す。SetFile の失敗を dmgbuild は無視するので下で検査する
  # size は .app を入れる前の仮の大きさ (dmgbuild が最後に最小まで縮め、.app を入れる時に広げ直す)
  env -u DEVELOPER_DIR -u SDKROOT uv run --locked --script "$root/scripts/run-dmgbuild.py" --no-hidpi \
    -s "$root/scripts/dmg-settings.py" -D "background=$bg" -D "icon=$root/src-tauri/icons/icon.icns" -D size=64m \
    mukuchi "$DMG_TEMPLATE"
  mkdir "$tmp/mnt"
  mnt_attach "$DMG_TEMPLATE" "$tmp/mnt" -readonly
  python3 "$root/scripts/check-dmg-layout.py" --template "$tmp/mnt" || ok=1
  mnt_detach "$tmp/mnt"
  rm -rf "$tmp"
  [ "$ok" -eq 0 ] || die "dmg テンプレートの見た目が想定と違う ($DMG_TEMPLATE)"
}

case "$mode" in release | build-only | local-dmg) make_dmg_template ;; esac

if [ "$mode" = build-only ]; then
  echo "done (署名なし): $APP, $DMG_TEMPLATE"
  exit 0
fi
[ -d "$APP" ] || die "$APP がない (先に scripts/build-macos.sh --build-only)"

# ---- 署名 --------------------------------------------------------------------------------------

sign_app() {
  local id="$1" ts
  # 拡張属性 (Finder 情報等) が残っていると codesign が失敗する (Apple QA1940)
  /usr/bin/xattr -cr "$APP"
  # 同梱 uv (Contents/Helpers/uv) は開発元の Developer ID 署名・公証済みのまま使う。
  # --deep を使わないので再署名されない (外側の署名が入れ子のコードとしてその署名を検証して封印する)。
  # 本体以外に Mach-O を置かない前提。増えたら内側から個別に署名する
  if [ "$id" = "-" ]; then ts="--timestamp=none"; else ts="--timestamp"; fi
  /usr/bin/codesign --force --sign "$id" --options runtime "$ts" --entitlements "$ENTITLEMENTS" "$APP"
}

# ---- .dmg の作成 (署名側。Apple のツールと標準ライブラリだけの python3 のみ) ----------------------------

# テンプレートに .app を入れて UDZO の .dmg を作る。dmg_file に結果のパスを入れる
dmg_file=""
make_dmg() {
  local tmp rw mnt version kb ok=0
  [ -f "$DMG_TEMPLATE" ] || die "$DMG_TEMPLATE がない (先に scripts/build-macos.sh --build-only)"
  version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
  dmg_file="$BUNDLE_DIR/dmg/mukuchi_${version}_aarch64.dmg"
  step "create $(basename "$dmg_file")"
  tmp="$(mktemp -d)"; rw="$tmp/rw.dmg"; mnt="$tmp/mnt"
  mkdir -p "$BUNDLE_DIR/dmg" "$mnt"
  /bin/cp "$DMG_TEMPLATE" "$rw"
  # .app + 余裕 32MB まで広げる (HFS+ はそのまま広げられる)
  kb="$(du -sk "$APP" | cut -f1)"
  /usr/bin/hdiutil resize -size "$((kb + 32 * 1024))k" "$rw"
  mnt_attach "$rw" "$mnt" -owners off
  # テンプレートは build job から来るため、入れる前に余計なファイルがないことを確かめる
  # 失敗しても切断してから止まるよう、途中の失敗は ok で受ける
  { python3 "$root/scripts/check-dmg-layout.py" --template "$mnt" \
      && /usr/bin/ditto "$APP" "$mnt/mukuchi.app" \
      && rm -rf "$mnt/.fseventsd" "$mnt/.Trashes" \
      && python3 "$root/scripts/check-dmg-layout.py" "$mnt"; } || ok=1
  mnt_detach "$mnt"
  [ "$ok" -eq 0 ] || { rm -rf "$tmp"; die "dmg の見た目が想定と違う"; }
  /usr/bin/hdiutil resize -sectors min "$rw"
  # UDZO (zlib): Apple は強く圧縮した dmg を避けるよう案内している (Customizing the notarization workflow)
  /usr/bin/hdiutil convert "$rw" -format UDZO -ov -o "$dmg_file" >/dev/null
  rm -rf "$tmp"
  /usr/bin/hdiutil verify "$dmg_file"
}

if [ "$mode" = local ] || [ "$mode" = local-dmg ]; then
  step "codesign (ad-hoc)"
  sign_app -
  # 見た目の確認用なので .dmg は署名しない
  [ "$mode" = local-dmg ] && make_dmg
  step "verify (ad-hoc)"
  scripts/verify-macos.sh
  [ "$mode" = local-dmg ] && echo "done: $dmg_file (Finder で開いてウィンドウを確認する)"
  exit 0
fi

# 別の版の古い .dmg が残っていると verify が取り違えるため消す (--sign-only はビルドを経ない)
rm -rf "$BUNDLE_DIR/dmg"
step "codesign ($identity_name)"
sign_app "$identity"
/usr/bin/codesign --verify --deep --strict "$APP"

# ---- 公証 --------------------------------------------------------------------------------------

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# notarytool submit --wait。Accepted 以外ならログを出して失敗する。
# submit 自体が失敗した場合 (--wait のタイムアウト・通信断・Invalid 等) も、提出済みなら出力に id があるのでログを取る
notarize() {
  local file="$1" out="$work/submit.json" err="$work/submit.err" status id rc=0
  step "notarize $(basename "$file")"
  hostxcrun notarytool submit "$file" "${notary_args[@]}" --wait --timeout 2h --output-format json >"$out" 2>"$err" || rc=$?
  status="$(/usr/bin/plutil -extract status raw -o - "$out" 2>/dev/null || true)"
  id="$(/usr/bin/plutil -extract id raw -o - "$out" 2>/dev/null || true)"
  if [ -z "$id" ]; then
    # JSON でない出力 (進捗表示・エラー文) からも submission id (UUID) を拾う
    id="$(grep -hoiE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' "$out" "$err" | head -n1 || true)"
  fi
  echo "submission ${id:-(不明)}: ${status:-(不明)}"
  if [ "$rc" -ne 0 ] || [ "$status" != "Accepted" ]; then
    cat "$out" "$err" >&2
    if [ -n "$id" ]; then
      hostxcrun notarytool log "$id" "${notary_args[@]}" >&2 || echo "(notarytool log を取れなかった: xcrun notarytool log $id)" >&2
    fi
    if [ "$rc" -ne 0 ]; then die "notarytool submit が失敗 (終了コード $rc)"; fi
    die "公証が通らなかった ($status)"
  fi
}

staple() {
  step "staple $(basename "$1")"
  hostxcrun stapler staple "$1"
  hostxcrun stapler validate "$1"
}

# 1回目: .app を公証して staple する。dmg だけを公証すると中の .app には票 (ticket) が付かず、
# dmg からコピーした .app を初めて開く時にオフラインだと Gatekeeper が確認できないため
app_zip="$work/mukuchi.zip"
/usr/bin/ditto -c -k --keepParent --sequesterRsrc "$APP" "$app_zip"
notarize "$app_zip"
staple "$APP"

# ---- .dmg --------------------------------------------------------------------------------------

make_dmg
dmg="$dmg_file"
/usr/bin/codesign --force --sign "$identity" --timestamp "$dmg"

# 2回目: .dmg を公証して staple する (ダウンロードした dmg を開く時の確認用)
notarize "$dmg"
staple "$dmg"

if [ "$mode" = sign-only ]; then
  echo "done: $dmg (検証は scripts/verify-macos.sh)"
  exit 0
fi
step "verify"
scripts/verify-macos.sh
echo "done: $dmg"
