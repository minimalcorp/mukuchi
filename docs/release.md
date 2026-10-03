# リリース (署名・公証)

配布物は Developer ID 署名 + 公証 (notarization) + staple 済みの `.dmg` と、自動アップデート用の同じ .app の `.app.tar.gz` (Mac App Store は対象外)。
証明書・API キー・パスワードはリポジトリに置かない。

## 流れ (`make build` = `apps/desktop/scripts/build-macos.sh`)

1. 資格情報を確認 (無ければビルド前に日本語のエラーで止まる)
2. `tauri build --bundles app --no-sign` で .app。dmgbuild で .dmg のテンプレート (見た目だけ。.app なし) を作る (下記「.dmg の見た目」)
3. `codesign --options runtime --timestamp --entitlements apps/desktop/src-tauri/Entitlements.plist` で .app に署名 (`--deep` なし。同梱 uv `Contents/Helpers/uv` は開発元の署名のまま)
4. .app を zip にして `notarytool submit --wait` → `stapler staple`
5. staple 済みの .app を updater 用の tar.gz にする (下記「アップデートの配布物」)
6. テンプレートに staple 済みの .app を `hdiutil`・`ditto` で入れて UDZO の .dmg にし、署名 → 公証 → staple
7. `apps/desktop/scripts/verify-macos.sh` (`make verify`)

生成物 (`apps/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/` の下):

- `dmg/mukuchi_<version>_aarch64.dmg`
- `updater/mukuchi_aarch64.app.tar.gz` (署名 (.sig)・`latest.json` は作らない。CI の publish-desktop が作る)

手順 2 だけを `apps/desktop/scripts/build-macos.sh --build-only` (資格情報を見ない)、3〜6 だけを `--sign-only` (Apple のツールと標準ライブラリだけの python3 のみ。pnpm・cargo・uv の依存・本体を実行しない。7 は行わない) で実行できる。`make build` は両方を続けて行う。CI はこれを別 job に分け、第三者の依存が動くビルドを secret のない場所で行う。

`make build-local` は手順 2・3 を ad-hoc 署名で行う (公証しない)。`make dmg-local` はそれに加えて .dmg を作る (署名・公証しない。ウィンドウの見た目の確認用)。`make verify` は ad-hoc の場合 Gatekeeper・公証・.dmg の署名の項目を SKIP と表示する。

### アップデートの配布物

仕様は docs/architecture.md の「アップデート」。Release `desktop-v<X.Y.Z>` に次の2つを添付する (.dmg と .dmg.sha256 に加えて):

- `mukuchi_aarch64.app.tar.gz`: 公証・staple 済みの .app。最上位は `mukuchi.app/` (tauri-plugin-updater 2.13 は各エントリの先頭のパス要素を1つ捨てて展開し、.app と置き換える。`install_inner`)。`COPYFILE_DISABLE=1 /usr/bin/tar --no-mac-metadata --no-xattrs --no-acls --no-fflags` で AppleDouble (`._*`)・xattr を入れない。`apps/desktop/scripts/check-updater-archive.py` が最上位・余計なエントリがないこと・中身が .app と同じことを確かめる
- `latest.json`: `{"version","pub_date","platforms":{"darwin-aarch64":{"signature","url"}}}`。url は版付き `https://github.com/minimalcorp/mukuchi/releases/download/desktop-v<X.Y.Z>/mukuchi_aarch64.app.tar.gz`。notes は書かない

アプリは `https://github.com/minimalcorp/mukuchi/releases/latest/download/latest.json` を見る (公開済み・非プレリリースの Latest の添付)。

platforms のキー: plugin は macOS で `darwin-aarch64-app` → `darwin-aarch64` の順に探す (`updater.rs` の `get_urls`。.app/.dmg は `app`)。前者のみだとバンドルの種類の判定 (`tauri_utils::platform::bundle_type`) に依存するため、後者だけを書く。

#### アップデートの署名

`scripts/sign-updater.mjs` (Node の標準ライブラリのみ。テスト `scripts/sign-updater.test.mjs`) が tauri signer と同じ形式で署名する (署名鍵を読む job で tauri-cli・minisign 等の第三者のコードを動かさないため)。形式は tauri-cli 2.12.0 が使う minisign crate 0.9.1 に合わせる:

- 秘密鍵 (`TAURI_SIGNING_PRIVATE_KEY`): 鍵ファイルの中身 = base64 で包んだ minisign の秘密鍵 (`Ed`・`Sc` (scrypt)・`B2` (BLAKE2b-256 のチェックサム))。scrypt の N・r・p は鍵の opslimit・memlimit から minisign と同じ方法で決める (`tauri signer generate` の既定は N=2^15, r=8, p=1)
- 署名: prehashed Ed25519 (`ED`。本体はファイルの BLAKE2b-512 に対する署名)。global signature は本体 + trusted comment に対する署名
- trusted comment: `timestamp:<unix秒>\tfile:mukuchi_aarch64.app.tar.gz\tversion:<X.Y.Z>` (`tauri signer sign --app-version` と同じ)。plugin の `requireSignedVersion: true` が `version:` と `latest.json` の版の一致を見る
- 書く前に `tauri.conf.json` の `plugins.updater.pubkey` で検証する (鍵の取り違えをリリース前に止める)
- tauri signer は Ed25519 の nonce に乱数を混ぜるため、同じ入力でも署名のバイト列は毎回変わる (sign-updater.mjs は RFC 8032 どおり決定的)。どちらも同じ公開鍵で検証できる。テストは tauri signer の出力 (フィクスチャ) との形式の一致と相互の検証を確かめる。テストの鍵は `scripts/fixtures/updater-test-key/` のテスト専用の鍵 (本番と無関係)

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

### 3. updater の署名鍵

一度作ったら変えない (変えると既存の利用者に更新を届けられない。下記)。

1. 鍵を作る (パスワードを付ける。パスワードは対話入力):
   ```sh
   pnpm -C apps/desktop tauri signer generate -w ~/.config/mukuchi/updater.key
   ```
   `~/.config/mukuchi/updater.key` (秘密鍵。リポジトリに置かない) と `.pub` (公開鍵) ができる
2. 公開鍵 (`.pub` の中身そのまま) を `apps/desktop/src-tauri/tauri.conf.json` の `plugins.updater.pubkey` に書いて PR で入れる
3. secret に登録する:
   ```sh
   R=minimalcorp/mukuchi
   gh secret set TAURI_SIGNING_PRIVATE_KEY -R $R --env production-desktop < ~/.config/mukuchi/updater.key
   gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R $R --env production-desktop   # 対話入力
   ```
4. 秘密鍵ファイルとパスワードを GitHub の外 (パスワードマネージャー等) に保管する。GitHub の secret は読み出せないため、ここが唯一の控えになる。保管したら手元の `updater.key` は消してよい

鍵を失った・漏れた時:

- 失った (秘密鍵かパスワード): 既存の利用者 (今の公開鍵を持つ .app) には以後の更新を届けられない。新しい鍵を作って 1〜3 を行い、次の版を出す。既存の利用者は LP から .dmg を入れ直す必要がある (アプリ内では「確認」は失敗し続ける)。告知する
- 漏れた: 偽の更新を作れるが、配るには `latest.json` (このリポジトリの Latest の Release) を書き換える必要がある。すぐに新しい鍵に替える (失った時と同じ)。漏れた鍵で署名した版が出ていないか Release を確認する
- 計画的に替える: 新しい公開鍵を入れた版を **古い鍵で** 署名して出し、その次の版から新しい鍵で署名する (secret を差し替える)。その間の版を入れなかった利用者は、次の版の検証に失敗する (Latest しか見ないため)

### 4. GitHub Actions (`.github/workflows/release.yml`) の secret・変数

Environment は3つ。どれも deployment branch policy は `main` のみ。値は Environment の secret・変数に登録し、repo secret にはしない (その Environment を指定した job だけが読める)。作成は `.claude/plans/github-setup.md`。

| Environment | 用途 | 承認者 (Required reviewers) | secret | 変数 |
|---|---|---|---|---|
| `release-approval` | 承認専用 (`approve` job。Release・Undeploy web の先頭で1回) | あり | なし (置かない) | なし |
| `production-desktop` | desktop の署名・公証・公開 | なし | `APPLE_CERTIFICATE` `APPLE_CERTIFICATE_PASSWORD` `APPLE_API_KEY` `APPLE_API_ISSUER` `APPLE_API_KEY_P8` `RELEASE_DEPLOY_KEY` `TAURI_SIGNING_PRIVATE_KEY` `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | - |
| `production-web` | web のデプロイ・版上げの push・撤去 | なし | `RELEASE_DEPLOY_KEY` | `AWS_DEPLOY_ROLE_ARN` `AWS_REGION` `MUKUCHI_WEB_CERT_ARN` |

- `release-approval` の作り方: Settings > Environments > New environment で `release-approval` を作り、Required reviewers に承認者を入れる (必要なら Prevent self-review)。Deployment branches and tags は Selected branches and tags で `main` のみ。secret・変数は置かない
- `production-desktop` / `production-web`: Required reviewers は付けない (付けるとその job でもう一度承認待ちになる)。Deployment branches は `main` のみ。secret・変数はここに置く
- `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD`: updater の署名鍵 (上の「3. updater の署名鍵」)。publish-desktop の署名の step だけに渡す
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

jobs: `approve` (承認) → `prepare` → `build` → `sign` → `publish-desktop` → `deploy-web-for-desktop`

1. `Approve` (`release-approval`): 承認を待つだけ。承認後の job は承認を求めない
2. `Prepare`: main 以外からの実行を止める → 版上げコミットをローカルで作る → 同じタグ・公開済みの Release があれば止める
3. `Build unsigned .app` (secret なし): Kyoko の有無を確認 → 同じ版上げコミットを作る (ID を確認) → `pnpm install --frozen-lockfile` → `build-macos.sh --build-only`。.app と .dmg テンプレートを artifact で渡す
4. `Sign and notarize (.dmg)` (`production-desktop`): .app の版を確認 → 証明書を一時キーチェーンに入れて `build-macos.sh --sign-only` (updater 用の tar.gz も作る) → 資格情報を削除 → `verify-macos.sh` → 添付を用意して artifact `mukuchi-dmg-signed` (7日保存) にする。中身は `mukuchi_aarch64.dmg`・`mukuchi_aarch64.dmg.sha256`・`mukuchi_aarch64.app.tar.gz`・`mukuchi_aarch64.app.tar.gz.sha256` (版番号なし。LP の固定 URL 用。版は Release のタイトル・タグで分かる。tar.gz の .sha256 は publish での確認用で添付しない)
5. `Publish desktop` (`production-desktop`。Deploy Key で checkout し、第三者のパッケージを入れない):
   1. sha256 を確認 → 同じ版上げコミットを作る (ID を確認) → main が開始時のままでタグがないことを確認
   2. `scripts/sign-updater.mjs` で tar.gz に署名して `latest.json` を作る (署名鍵はこの step にだけ渡す。`tauri.conf.json` の公開鍵で検証してから書く)
   3. 下書きの Release `desktop-v<version>` を作って4つ (.dmg・.dmg.sha256・.app.tar.gz・latest.json) を添付する (下書きはタグを作らない。アップロードの失敗はここで起き、main は変わらない)
   4. 版上げコミットとタグを push (失敗したら下書きを消して止める。公開されない)
   5. 下書きを公開して Latest にし、`releases/latest` がこのタグであることを確かめる
   6. `releases/latest/download/latest.json` (アプリの endpoint) が今回の `latest.json` と同じ中身を返すことを確かめる (10秒おきに最大6回。合わなくても job は失敗にせず警告を出す。LP の更新 (次の job) を止めないため)

公開後の確認: LP は `https://github.com/minimalcorp/mukuchi/releases/latest/download/mukuchi_aarch64.dmg` を使い、これは公開済み・非プレリリースの Latest の Release の添付を返す ([Linking to releases](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)、[Get the latest release](https://docs.github.com/en/rest/releases/releases#get-the-latest-release))。`curl -sIL <URL> | grep -i '^location'` で新しいタグを指すことを確かめる。

6. `Deploy web (desktop version)` (`production-web`): LP の版の表示を公開した desktop に合わせる。LP (`apps/web/app/lib/site.ts` の `VERSION`。フッター・ダウンロードの補足・動作環境の表) はビルド時に `apps/desktop/src-tauri/tauri.conf.json` の版を読むため、配信し直すだけで合う
   - ソースは **最後の web のタグ** (`web-v*` の最大) に、`desktop-v<version>` の `tauri.conf.json` だけを重ねたもの。main は使わない (未リリースの web の変更を出さないため)。web の版・タグは変えない
   - 配信前にビルドして `v<version>` が含まれることを確かめる。版を `tauri.conf.json` から読まない古い web のタグ (`web-v0.1.2` 以前) だと止まる。その場合は web を一度リリースする
   - target=web のリリースも main の `tauri.conf.json` を読むため、最新の desktop の版を表示する
   - Undeploy web で撤去した後でも配信する (撤去中は desktop のリリースで LP が復活する)

`DMG_SIZE` は自動では変わらない。添付の実測 (`gh release view desktop-v<version> --json assets --jq '.assets[]|[.name,.size]|@tsv'`) が大きく変わったら PR で直し、web をリリースする。

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
| publish-desktop の updater の署名 (鍵・パスワード違い、公開鍵と対でない) | main・タグ・Release は変わらない | secret と `tauri.conf.json` の `pubkey` を確認して実行し直す (公開鍵を替えると既存の利用者に届かない。「3. updater の署名鍵」) |
| publish-desktop の公開 (push 後) | main・タグは push 済み。下書きの Release が残る (deploy-web-for-desktop は動かない) | 下書き `desktop-v<version>` を確認して手で公開し、Latest にする。LP は web をリリースして合わせる |
| publish-desktop の Check updater endpoint (警告) | 公開済み (Latest)。job は成功し LP も更新される。アプリが新しい版を見つけない可能性 | `curl -sL https://github.com/minimalcorp/mukuchi/releases/latest/download/latest.json` を確認する。Release に `latest.json` がなければ artifact から手で添付する (下書き・公開の前の artifact `mukuchi-dmg-signed` の tar.gz に対し、手元で `sign-updater.mjs` を実行して作る。鍵が要る) |
| deploy-web-for-desktop | desktop は公開済み。LP は前の版の表示のまま (配信中の失敗は途中の可能性あり) | 原因を直してこの job を Re-run する (古い web のタグで止まった時は web をリリースする) |
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
| updater の tar.gz | `check-updater-archive.py` (最上位が `mukuchi.app/`・`._*`/xattr なし・中身が .app と同じ)、`--strip-components 1` で展開した .app の `codesign --verify --deep --strict`・CDHash が .app と同じ・`stapler validate` |
| .dmg | `codesign --verify --strict`、`spctl -a -vv -t open --context context:primary-signature`、`stapler validate`、中の .app が同じ CDHash で staple 済み、見た目 (`apps/desktop/scripts/check-dmg-layout.py`) |

## 出典

- [Placing content in a bundle](https://developer.apple.com/documentation/bundleresources/placing-content-in-a-bundle) (helper tool は `Contents/MacOS/` か `Contents/Helpers/`)
- [Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow) / [Resolving common notarization issues](https://developer.apple.com/documentation/security/resolving-common-notarization-issues)
- [Create Developer ID certificates](https://developer.apple.com/help/account/certificates/create-developer-id-certificates) / [Creating API keys for App Store Connect API](https://developer.apple.com/documentation/appstoreconnectapi/creating-api-keys-for-app-store-connect-api)
- [Installing an Apple certificate on macOS runners](https://docs.github.com/en/actions/use-cases-and-examples/deploying/installing-an-apple-certificate-on-macos-runners-for-xcode-development)
- [dmgbuild settings](https://dmgbuild.readthedocs.io/en/latest/settings.html)。HiDPI 背景の扱い・`--no-hidpi`・ボリュームアイコン (`SetFile -a C`) は dmgbuild 1.6.7 のソース (`src/dmgbuild/core.py`, `__main__.py`)
- Tauri の署名・公証の実装: tauri-cli 2.12.0 (`crates/tauri-bundler/src/bundle/macos/{app,sign}.rs`、`crates/tauri-macos-sign/src/lib.rs`)
- updater の署名: tauri-cli 2.12.0 `crates/tauri-cli/src/helpers/updater_signature.rs` (`sign_file`・`secret_key`)。minisign crate 0.9.1 (tauri-cli の Cargo.lock の版。`src/{lib,secret_key,helpers,signature_box,constants}.rs`: `sign`・`prehash`・`SecretKey::from_box`・`raw_scrypt_params`)。[minisign の形式](https://jedisct1.github.io/minisign/)
- updater の検証・展開: tauri-plugin-updater 2.13.1 `src/updater.rs` (`verify_signature`・`verify_signed_version`・`get_urls`・`install_inner`)、minisign-verify 0.2.5。tar.gz の作り方は tauri-bundler `src/bundle/updater_bundle.rs` (`create_tar_from_src`)
- [Tauri: Updater](https://v2.tauri.app/plugin/updater/)
