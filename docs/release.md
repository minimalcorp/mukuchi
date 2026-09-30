# リリース (署名・公証)

配布物は Developer ID 署名 + 公証 (notarization) + staple 済みの `.dmg` のみ (Mac App Store は対象外)。
証明書・API キー・パスワードはリポジトリに置かない。

## 流れ (`make build` = `apps/desktop/scripts/build-macos.sh`)

1. 資格情報を確認 (無ければビルド前に日本語のエラーで止まる)
2. `tauri build --bundles app --no-sign` で .app。dmgbuild で .dmg のテンプレート (見た目だけ。.app なし) を作る (下記「.dmg の見た目」)
3. `codesign --options runtime --timestamp --entitlements apps/desktop/src-tauri/Entitlements.plist` で .app に署名 (`--deep` なし。同梱 uv `Contents/Helpers/uv` は開発元の署名のまま)
4. .app を zip にして `notarytool submit --wait` → `stapler staple`
5. テンプレートに staple 済みの .app を `hdiutil`・`ditto` で入れて UDZO の .dmg にし、署名 → 公証 → staple
6. `apps/desktop/scripts/verify-macos.sh` (`make verify`)

生成物: `apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/mukuchi_<version>_aarch64.dmg`

手順 2 だけを `apps/desktop/scripts/build-macos.sh --build-only` (資格情報を見ない)、3〜5 だけを `--sign-only` (Apple のツールと標準ライブラリだけの python3 のみ。pnpm・cargo・uv の依存・本体を実行しない。6 は行わない) で実行できる。`make build` は両方を続けて行う。CI はこれを別 job に分け、第三者の依存が動くビルドを secret のない場所で行う。

`make build-local` は手順 2・3 を ad-hoc 署名で行う (公証しない)。`make dmg-local` はそれに加えて .dmg を作る (署名・公証しない。ウィンドウの見た目の確認用)。`make verify` は ad-hoc の場合 Gatekeeper・公証・.dmg の署名の項目を SKIP と表示する。

### .dmg の見た目

開いた時のウィンドウ: 背景 `assets/brand/dmg/background(@2x).png` (660x400pt)、左に mukuchi.app (中心 160,170)、右に Applications へのリンク (中心 500,170)、アイコン 128pt・文字 13pt、ツールバー・サイドバー・ステータスバーなし、アイコン表示・整列なし。ボリューム名 `mukuchi`、ボリュームアイコンはアプリアイコン (`apps/desktop/src-tauri/icons/icon.icns`)。

- 設定: `apps/desktop/scripts/dmg-settings.py` (dmgbuild の settings)。値を変えたら `apps/desktop/scripts/check-dmg-layout.py` の期待値も直す
- [dmgbuild](https://github.com/dmgbuild/dmgbuild) 1.6.7 を `apps/desktop/scripts/run-dmgbuild.py` (uv スクリプト、依存は `apps/desktop/scripts/run-dmgbuild.py.lock` に sha256 付きで固定) で動かす。Finder・AppleScript を使わず `.DS_Store` を直接書くため、画面に何も出ずに CI でも動く
- 背景は `tiffutil -cathidpicheck` で 1x と 2x を1つの TIFF にまとめて渡す (Retina では 2x が使われる)
- dmgbuild は第三者のコードなので、資格情報のない build 側でテンプレート (`bundle/dmg-template/mukuchi.dmg`、UDRW) だけを作る。sign 側はテンプレートの中身を確かめてから .app を入れる。`hdiutil convert` は同じ HFS+ ボリュームを写すので、`.DS_Store` 内の背景のエイリアスは有効なまま
- ウィンドウの高さ (`window_rect`) はタイトルバー込みなので 400 + 28pt にしている。macOS 26 はタイトルバーが 32pt で背景の下端 4pt (無地) が隠れる
- `make verify` は `.DS_Store` を標準ライブラリだけで読み、アイコン位置・表示設定・背景 (1x+2x)・ボリュームアイコン・余計なファイルがないことを確かめる。見た目そのものは Finder で開いて目で確認する

## 最初に1回だけ行うこと

Apple Developer Program (組織) への登録が前提。

### 1. Developer ID Application 証明書

作成できるのは Account Holder のみ (1チームにつき最大5つ)。

1. キーチェーンアクセス > 証明書アシスタント > 認証局に証明書を要求 で CSR (`.certSigningRequest`) を作る
2. [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list) > Certificates > + > **Developer ID Application** を選び、CSR をアップロードして `.cer` をダウンロード
3. `.cer` をダブルクリックしてログインキーチェーンに入れる
4. 確認: `security find-identity -v -p codesigning` に `Developer ID Application: <チーム名> (<Team ID>)` が出る

キーチェーンに Developer ID Application が複数ある場合は `APPLE_SIGNING_IDENTITY` に証明書の SHA-1 (`security find-identity` の40桁) か名前の一部を指定する (1つなら自動で選ばれる)。codesign には常に SHA-1 を渡す。

### 2. 公証の資格情報 (App Store Connect API キー)

notarytool で使えるのは **Team キー** のみ (Individual キーは notarytool を使えない)。Team キーの作成には App Store Connect の Admin 権限が要る。

1. [App Store Connect](https://appstoreconnect.apple.com/access/integrations/api) > ユーザとアクセス > 統合 > App Store Connect API > チームキー > 生成 (アクセスは Developer)
2. キーID と Issuer ID を控え、`AuthKey_<キーID>.p8` をダウンロードする (1回しかダウンロードできない)
3. `.p8` はリポジトリ外に置く (例: `~/.config/mukuchi/AuthKey_<キーID>.p8`、`chmod 600`)

手元で使う方法はどちらか:

- **キーチェーンプロファイル (推奨)**: 資格情報をキーチェーンに保存し、以後 `.p8` は不要
  ```sh
  xcrun notarytool store-credentials mukuchi --key ~/.config/mukuchi/AuthKey_XXXX.p8 --key-id XXXX --issuer <Issuer ID>
  ```
  プロファイル名を変えた場合は `MUKUCHI_NOTARY_PROFILE=<名前>`
- **環境変数**: `APPLE_API_KEY` (キーID)・`APPLE_API_ISSUER`・`APPLE_API_KEY_PATH` (`.p8` のパス)。`~/.config/mukuchi/notary.env` に書いておけば `make build` が読む
  ```sh
  APPLE_API_KEY=XXXX
  APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  APPLE_API_KEY_PATH=$HOME/.config/mukuchi/AuthKey_XXXX.p8
  ```
  (API キーの変数が1つでもあればプロファイルより優先する)

### 3. GitHub Actions (`.github/workflows/release.yml`) の secret

Environment `production-release` (Required reviewers で承認制。作成は `.claude/plans/github-setup.md`) の secret に登録する。repo secret にはしない。

1. キーチェーンアクセス > ログイン > 自分の証明書 で Developer ID Application の項目 (秘密鍵を含む) を書き出して `.p12` にする (パスワードを付ける)
2. 登録:
   ```sh
   R=minimalcorp/mukuchi
   base64 -i DeveloperID.p12 | gh secret set APPLE_CERTIFICATE -R $R --env production-release
   gh secret set APPLE_CERTIFICATE_PASSWORD -R $R --env production-release   # .p12 のパスワード (対話入力)
   gh secret set APPLE_API_KEY -R $R --env production-release                # キーID
   gh secret set APPLE_API_ISSUER -R $R --env production-release             # Issuer ID
   gh secret set APPLE_API_KEY_P8 -R $R --env production-release < ~/.config/mukuchi/AuthKey_XXXX.p8
   ```
3. 書き出した `.p12` は削除する

## リリース手順

### 手元で作る

1. `apps/desktop/src-tauri/tauri.conf.json` の `version` を上げる
2. `make build` (公証の待ち時間を含め数分〜。`make verify` まで自動で行う)
3. 別のユーザーアカウント (または別の Mac) で .dmg をダウンロード相当 (quarantine 付き) で開き、セットアップから音声入力まで通ることを確認する (実マイクでの確認は人が行う)

### GitHub Actions で作る

1. `version` を上げた変更を main に入れる
2. Actions > Release > Run workflow (main)
   - job `Build unsigned .app`: `pnpm install --frozen-lockfile` → `build-macos.sh --build-only` (secret なし)。.app を artifact で渡す
   - job `Sign and notarize (.dmg)`: `production-release` の承認後、証明書を一時キーチェーンに入れて `build-macos.sh --sign-only` → 資格情報を削除 → `verify-macos.sh`
3. 下書きの Release (`v<version>`、.dmg と .sha256 付き) を確認してから公開する

## main の required status checks

`.github/workflows/ci.yml` の job 名 (ruleset の context。job 名を変えたら ruleset も直す):

- `Rust (fmt, clippy, test)`
- `Frontend (lint, build, e2e)`
- `ASR server (ruff, pytest)`

## 確認コマンド (`make verify` の内容)

| 対象 | 確認 |
|---|---|
| .app | `codesign --verify --deep --strict`、Hardened Runtime、secure timestamp、entitlements がマイクのみ、Info.plist (バンドルID・`LSMinimumSystemVersion` 13.0・マイクの説明文)、`/nix/store` へのリンクなし、`mukuchi --print-uv-path` が `Contents/Helpers/uv`、`spctl -a -vv -t exec` が `Notarized Developer ID`、`stapler validate` |
| 同梱 uv | 開発元の Developer ID 署名 (Team ID 固定)・Hardened Runtime・timestamp。MacOS/・Helpers/ 以外に Mach-O がない |
| .dmg | `codesign --verify --strict`、`spctl -a -vv -t open --context context:primary-signature`、`stapler validate`、中の .app が同じ CDHash で staple 済み、見た目 (`apps/desktop/scripts/check-dmg-layout.py`) |

## 出典

- [Placing content in a bundle](https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle) (helper tool は `Contents/MacOS/` か `Contents/Helpers/`)
- [Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow) / [Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)
- [Create Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates) / [Creating API keys for App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)
- [Installing an Apple certificate on macOS runners](https://docs.github.com/en/actions/use-cases-and-examples/deploying/installing-an-apple-certificate-on-macos-runners-for-xcode-development)
- [dmgbuild settings](https://dmgbuild.readthedocs.io/en/latest/settings.html)。HiDPI 背景の扱い・`--no-hidpi`・ボリュームアイコン (`SetFile -a C`) は dmgbuild 1.6.7 のソース (`src/dmgbuild/core.py`, `__main__.py`)
- Tauri の署名・公証の実装: tauri-cli 2.12.0 (`crates/tauri-bundler/src/bundle/macos/{app,sign}.rs`、`crates/tauri-macos-sign/src/lib.rs`)
