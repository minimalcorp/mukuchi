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

### 3. GitHub Actions (`.github/workflows/release.yml`) の secret・変数

Environment は3つ。どれも deployment branch policy は `main` のみ。値は Environment の secret・変数に登録し、repo secret にはしない (その Environment を指定した job だけが読める)。作成は `.claude/plans/github-setup.md`。

| Environment | 用途 | 承認者 (Required reviewers) | secret | 変数 |
|---|---|---|---|---|
| `release-approval` | 承認専用 (`approve` job。Release・Undeploy web の先頭で1回) | あり | なし (置かない) | なし |
| `production-desktop` | desktop の署名・公証・公開 | なし | `APPLE_CERTIFICATE` `APPLE_CERTIFICATE_PASSWORD` `APPLE_API_KEY` `APPLE_API_ISSUER` `APPLE_API_KEY_P8` `RELEASE_DEPLOY_KEY` | - |
| `production-web` | web のデプロイ・版上げの push・撤去 | なし | `RELEASE_DEPLOY_KEY` | `AWS_DEPLOY_ROLE_ARN` `AWS_REGION` `MUKUCHI_WEB_CERT_ARN` |

- `release-approval` の作り方: Settings > Environments > New environment で `release-approval` を作り、Required reviewers に承認者を入れる (必要なら Prevent self-review)。Deployment branches and tags は Selected branches and tags で `main` のみ。secret・変数は置かない
- `production-desktop` / `production-web`: Required reviewers は付けない (付けるとその job でもう一度承認待ちになる)。Deployment branches は `main` のみ。secret・変数はここに置く
- `RELEASE_DEPLOY_KEY`: 書き込み可の Deploy key の秘密鍵 (両 Environment に同じもの)。main の ruleset の bypass に Deploy key を入れ、版上げコミットとタグを push する
- AWS の OIDC 用 IAM ロールの信頼ポリシーの `sub` は `repo:minimalcorp@93655726/mukuchi@1396207519:environment:production-web` (手順は `.claude/plans/aws-web-deploy-setup.md`)。このリポジトリは OIDC の immutable subject (所有者・リポジトリの ID 付き) が有効なため、`repo:minimalcorp/mukuchi:...` では一致しない。現在の形式は `gh api repos/minimalcorp/mukuchi/actions/oidc/customization/sub` の `sub_claim_prefix` で確かめる

Apple の secret の登録:

1. キーチェーンアクセス > ログイン > 自分の証明書 で Developer ID Application の項目 (秘密鍵を含む) を書き出して `.p12` にする (パスワードを付ける)
2. 登録:
   ```sh
   R=minimalcorp/mukuchi
   base64 -i DeveloperID.p12 | gh secret set APPLE_CERTIFICATE -R $R --env production-desktop
   gh secret set APPLE_CERTIFICATE_PASSWORD -R $R --env production-desktop   # .p12 のパスワード (対話入力)
   gh secret set APPLE_API_KEY -R $R --env production-desktop                # キーID
   gh secret set APPLE_API_ISSUER -R $R --env production-desktop             # Issuer ID
   gh secret set APPLE_API_KEY_P8 -R $R --env production-desktop < ~/.config/mukuchi/AuthKey_XXXX.p8
   ```
3. 書き出した `.p12` は削除する

## リリース手順

リリース・デプロイは Actions > Release > Run workflow (Branch: **main**) の手動実行だけで行う (main への push では何もデプロイしない)。入力は `target` (`desktop` | `web`) と `bump` (`patch` | `minor` | `major`)。同時に1つだけ動く (`undeploy-web.yml` も同じ group)。

### 版とタグ

| target | 版を持つファイル (すべて同じ版にそろえる) | タグ |
|---|---|---|
| desktop | `apps/desktop/src-tauri/tauri.conf.json` (.app の版の元)、`apps/desktop/src-tauri/Cargo.toml` の `[package]`、`apps/desktop/src-tauri/Cargo.lock` の mukuchi、`apps/desktop/package.json` | `desktop-v<X.Y.Z>` |
| web | `apps/web/package.json` | `web-v<X.Y.Z>` |

- 版は `X.Y.Z` のみ (プレリリースは Latest にならず LP の固定 URL が指さないため扱わない)。手で上げない。main にある版が「最後に出した版」になる
- `scripts/bump-version.mjs <desktop|web> <patch|minor|major> [--dry-run]` が版の行だけを書き換える (Node の標準ライブラリのみ。テストは `node --test scripts/*.test.mjs`、`make test` と CI に含む)
- `scripts/release-commit.sh` がその版上げをコミットする。作者・日時を固定するため、同じ開始コミットからなら別の job で作っても同じコミット ID になる。これで「ビルド・デプロイしたソース = push するコミット」を ID の一致で確かめる (desktop は .app に埋め込むコミットの短縮ハッシュもこのコミット)
- `scripts/release-push.sh` が版上げコミットと注釈付きタグを main へ `git push --atomic` する。main が run の開始時 (`github.sha`) から進んでいたら **rebase せずに止める** (ビルドしたソースと main・タグがずれないように)。その場合は Release を最初から実行し直す (版は同じ番号がもう一度選ばれる)
- ビルド・署名・公証・検証・デプロイのどれかが失敗したら、コミット・タグは push されない

### desktop

jobs: `approve` (承認) → `prepare` → `build` → `sign` → `publish-desktop`

1. `Approve` (`release-approval`): 承認を待つだけ。承認後の job は承認を求めない
2. `Prepare`: main 以外からの実行を止める → 版上げコミットをローカルで作る → 同じタグ・公開済みの Release があれば止める
3. `Build unsigned .app` (secret なし): Kyoko の有無を確認 → 同じ版上げコミットを作る (ID を確認) → `pnpm install --frozen-lockfile` → `build-macos.sh --build-only`。.app と .dmg テンプレートを artifact で渡す
4. `Sign and notarize (.dmg)` (`production-desktop`): .app の版を確認 → 証明書を一時キーチェーンに入れて `build-macos.sh --sign-only` → 資格情報を削除 → `verify-macos.sh` → 添付を用意して artifact `mukuchi-dmg-signed` (7日保存) にする。添付は `mukuchi_aarch64.dmg` と `mukuchi_aarch64.dmg.sha256` の2つ (版番号なし。LP の固定 URL 用。版は Release のタイトル・タグで分かる)
5. `Publish desktop` (`production-desktop`。Deploy Key で checkout し、第三者のパッケージを入れない):
   1. sha256 を確認 → 同じ版上げコミットを作る (ID を確認) → main が開始時のままでタグがないことを確認
   2. 下書きの Release `desktop-v<version>` を作って2つを添付する (下書きはタグを作らない。アップロードの失敗はここで起き、main は変わらない)
   3. 版上げコミットとタグを push (失敗したら下書きを消して止める。公開されない)
   4. 下書きを公開して Latest にし、`releases/latest` がこのタグであることを確かめる

公開後の確認: LP は `https://github.com/minimalcorp/mukuchi/releases/latest/download/mukuchi_aarch64.dmg` を使い、これは公開済み・非プレリリースの Latest の Release の添付を返す ([Linking to releases](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)、[Get the latest release](https://docs.github.com/en/rest/releases/releases#get-the-latest-release))。`curl -sIL <URL> | grep -i '^location'` で新しいタグを指すことを確かめる。

LP の表示 (`apps/web/app/lib/site.ts` の `VERSION`・`DMG_SIZE`) は自動では変わらない。desktop の公開後に PR で直し (サイズは添付の実測。`gh release view desktop-v<version> --json assets --jq '.assets[]|[.name,.size]|@tsv'`)、main に入れてから web をリリースする。

### web

jobs: `approve` (承認) → `prepare` → `deploy-web` → `publish-web`

1. `Approve`・`Prepare`: desktop と同じ
2. `Deploy web` (`production-web`): 同じ版上げコミットを作る (ID を確認) → `pnpm install --frozen-lockfile` → OIDC で AWS のロール → main が開始時のままか確認 → `sst deploy --stage production`
3. `Publish web` (`production-web`。Deploy Key): 同じ版上げコミットを作る → main が開始時のままでタグ `web-v<version>` がないことを確認 → push。GitHub Release は作らない

残るずれ: `deploy-web` の確認から `publish-web` の push までの間に main が進むと、デプロイは済んだが版上げ・タグは push されない (`publish-web` が止まる)。その時は Release (web) を実行し直す。前回と同じ版番号で、新しい main をデプロイしてタグを付ける (前回のデプロイは記録に残らない)。

### 承認

- 承認は run の先頭の `approve` job (`release-approval`) で1回だけ。承認するまで run のどの job も動かない (build も)。承認を拒否すれば何も変わらない
- 承認は job 単位で、Required reviewers のある Environment を使う job が始まる時にだけ求められる。そのため承認者は `release-approval` にだけ置く。`production-*` に承認者を置くと sign・publish 等でもう一度止まる
- 承認に secret のない専用の Environment を使うのは、承認のためだけの job に署名・デプロイの鍵を渡さないため
- 承認待ちの間も run は concurrency (group `release`) を占めるため、後から実行した Release・Undeploy web は待つ。待てるのは1件だけで、さらに実行すると待っていた方は取り消される ([Control the concurrency of workflows and jobs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency))
- Deploy Key を読む publish の job を、第三者のコード (pnpm・cargo の依存、ビルドした本体、sst) が動いた job と分けている (起動されたプロセスは job の終わりまで残りうるため、同じ job で鍵を読むと盗まれうる)。承認者がいないので、分けても承認は増えない

### 失敗した時

| 失敗した所 | 状態 | 対処 |
|---|---|---|
| approve (拒否・期限切れ)・prepare・build・sign・deploy-web | main・タグ・Release は変わらない (web の deploy 中の失敗はデプロイが途中の可能性あり) | 原因を直して実行し直す |
| publish-desktop の push まで (main が進んだ等) | main・タグは変わらない。下書きは消す | 実行し直す |
| publish-desktop の公開 (push 後) | main・タグは push 済み。下書きの Release が残る | 下書き `desktop-v<version>` を確認して手で公開し、Latest にする |
| publish-web の push (main が進んだ等) | デプロイ済み・main・タグは変わらない | 実行し直す (上の「残るずれ」) |

### 手元で作る (確認用。タグ・Release は作らない)

1. `make build` (公証の待ち時間を含め数分〜。`make verify` まで自動で行う)。版は main のまま (版を変えたい時は `node scripts/bump-version.mjs desktop patch` をコミットせずに使う)
2. 別のユーザーアカウント (または別の Mac) で .dmg をダウンロード相当 (quarantine 付き) で開き、セットアップから音声入力まで通ることを確認する (実マイクでの確認は人が行う)

### verify.wav の音声 (Kyoko)

`apps/desktop/scripts/make-verify-wav.sh` は `say -v Kyoko` で検証用音声を作る。GitHub の macOS ランナーに Kyoko が入っているかは公式に記載がなく、追加音声が入っていないという報告がある ([actions/runner-images#12320](https://github.com/actions/runner-images/issues/12320)、not planned で閉じられた)。build job は最初に `say -v '?'` で確かめ、無ければ使える音声の一覧を出して止まる。その場合の代わり (選んでから実装する):

- 手元 (Kyoko あり) で作った `verify.wav` を GitHub の Release 等に置き、build job で sha256 を固定して取得する (合成音声のみで人の声は含まない。Apple の音声の出力を再配布してよいかは要確認)
- ランナーにある他の日本語音声 (一覧に `ja_JP` があれば) に切り替える。ASR が「確認します。」と認識できるかを確かめる
- self-hosted runner (Kyoko を入れた Mac) で build job を動かす

## main の required status checks

`.github/workflows/ci.yml` の job 名 (ruleset の context。job 名を変えたら ruleset も直す):

- `Rust (fmt, clippy, test)`
- `Frontend (lint, build, e2e)`
- `ASR server (ruff, pytest)`
- `Web (lint, typecheck, build)`

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
