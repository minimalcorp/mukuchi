# アーキテクチャ・決定事項

## 全体構成

```
mukuchi.app (1プロセス)
 ├─ WebView ×3 (React): panel(常時表示パネル) / settings(設定) / setup(初回セットアップ)
 │     ↕ Tauri invoke / event
 ├─ Rust: 録音 cpal → VAD Silero/ort → 発話切り出し → ASRクライアント → 入力キュー
 └─ メニューバー (macOS標準メニュー)
       ↕ HTTP 127.0.0.1
asr-server (別プロセス / Python + mlx-qwen3-asr)
```

UIデザインの正: Claude Design handoff「mukuchi UI Proposal」(社内デザインシステムを含むためgit管理外)。実装計画は [docs/plans/implementation-plan.md](plans/implementation-plan.md)。

## 決定事項

| 項目 | 決定 | 理由・備考 |
|---|---|---|
| 対象OS | macOS (Apple Silicon, aarch64のみ) | MLXがApple Silicon専用 |
| フレームワーク | Tauri v2 + Rust | 入力送信・常駐の軽さ |
| フロントエンド | React + TypeScript + Vite + Tailwind + shadcn/ui + lucide-react。色・モーション等は `apps/desktop/src/styles/tokens.css` のCSS変数 (実装で使う値だけを置く)。フォントはIBM Plex Sans JP / Mono を同梱 (オフラインで動くようGoogle Fontsは使わない) | |
| ダークモード | システム設定に追従。デザインの参考表示(gray 700〜900を面に使用)に従う | |
| 録音 | Rust (cpal) | WebView経由のgetUserMediaは権限ダイアログ二重表示等の既知問題あり |
| VAD | Silero VAD (`ort`、arm64は静的リンク)。差し替え可能なtraitの背後に置く | 代替: earshot |
| ASR | Python + MLX (`mlx-qwen3-asr`)。既定のモデルは `neosophie/Qwen3-ASR-1.7B-JA` を全層8bit量子化したもの (自前変換、`minimalcorp/Qwen3-ASR-1.7B-JA-MLX-8bit`、約2.2GB)。元の bf16 版 (`neosophie/Qwen3-ASR-1.7B-JA`、約4.1GB) は既に手元にある導入でのみ一覧に出る (下の「モデルの管理」)。どちらも revision (commit) を固定して取得 | Rust実装(candle/MLX)は約3倍遅い (spikes/asr-bench)。8bitはfp16と同等精度・約2割速い・メモリ1/3 (spikes/asr-bench/MODEL_DECISION.md) |
| モデルの管理 | 候補はアプリに固定 (`provisioning/models.rs` の `CATALOG`)。常に「取得済みのモデルが1つ選択されている」状態を保つ (取得途中は選べない、選択中は削除できない)。取得 (進捗・一時停止・再開・中止)・削除はモデルごと。**取得中にできるのは1つ** (一時停止・失敗で止まっているものは複数あってよい)。モデルの操作はセットアップ完了後のみ (セットアップの取得と同時に走らせない)。詳細は「モデルの管理」の節 | 2026-10-01 決定 |
| 操作 | 音声入力のON/OFFは **常時表示パネルのボタン**・**メニューバー**・**グローバルショートカット** (既定 ⌥Space、`Settings.shortcut` で変更・無効化可。`tauri-plugin-global-shortcut` = macOS は Carbon `RegisterEventHotKey` で追加の権限は不要)。押下で、OFF なら ON。ON なら入力モードで分岐: 常に聞き取る→OFF / 1回ずつ聞き取るで未発話→取り消して OFF / 発話中→無音を待たずに確定して OFF。押している間だけ録音するモードは実装しない | 2026-09-30 確定、2026-10-02 ショートカットを追加 (周囲に人がいる環境で入力のタイミングを自分で決める「1回ずつ聞き取る」の開始手段として) |
| 入力単位 | ONの間、発話(VAD区間)ごとに文字起こしし、話し終わったら入力。入力は単一キューで直列化 | 必須要件 |
| 入力モード | `Settings.inputMode`。`continuous` (常に聞き取る・既定): ONの間ずっと発話ごとに入力。`oneShot` (1回ずつ聞き取る): ONにしてから1発話を確定 (VAD の話し終わり・最大長、またはショートカットの再押下) したら自動で OFF。短すぎる発話 (誤検出) では OFF にしない。ON (または誤検出) から10秒 (固定) 話し始めなければ OFF。開始手段 (パネル・メニューバー・ショートカット) によらず同じ。セットアップの「入力モード」ステップと 設定 > 音声入力 で選ぶ | 2026-10-02 決定。ひとりなら常に聞き取る、周りに人がいる・会話が聞こえる場所では入力のタイミングを自分で決めたいため |
| リアルタイムプレビュー | 発話中は前回から音声が0.8秒以上伸び、かつ途中表示の要求が処理中でなければ、発話開始からの音声を文字起こしし直してパネルに表示する。入力するのは話し終わり時点の最終結果のみ。確定後は最終結果で表示を置き換えて750ms表示する (入力成功時は成功マークのみで入力先アプリ名は出さない)。推論時間の見積もり(実測から学習)が話し終わりの無音(silenceMs)を超える場合は送らない。長い発話は区切り (見積もりが silenceMs に収まる最長、3〜12秒) ごとに静かな所で確定し、以後は区切りの後の音声だけを送る (表示は確定した区切りの文字 + 今の区切りの文字。1回の推論が発話の長さに比例して伸びず、確定を遅らせない) | 2026-09-30 確定。値はtsunagiの音声入力に準拠 (implementation-plan.md「音声入力の体験」)。途中表示の応答待ちを取り消してもサーバーの推論は止まらず(直列実行)、確定がその分遅れるため |
| 入力方式 | クリップボード + ⌘V、元のクリップボードを復元 | IMEの影響を受けない |
| 音声コマンド | 「言い方→キー」対応表(既定: 確定/エンター→Enter、改行→Shift+Enter、送信→⌘+Enter)。発話全体が正規化後に完全一致した時のみ。機能ごとON/OFF可 | 表記揺れは複数の言い方で吸収 |
| パネルの表示形式 | 通常 (プレビュー・状態の文言あり) と コンパクト (マイクの円形ボタンのみ。OFF=グレー、ON=青、発話中は音量に合わせて広がるリング、文字起こし中は回転するリング、エラーは赤い点) を `Settings.panelStyle` で切り替え。パネルの右クリックメニューのチェック項目「コンパクト表示」と 設定 > 一般 から切り替える | 2026-09-30 決定。デザインは既存トークンで作成 |
| 入力しないアプリ | 登録したアプリが前面にある間は入力しない(パネルに「このアプリには入力しません」) | デザインの任意提案Aを採用 |
| メニューバー | macOS標準のメニュー(NSMenu)。状態・エラーは文字の行、復旧はメニュー項目で表す。アイコンはロゴ (`assets/brand/macos/MenuBarIcon`) から作ったテンプレート画像: OFF=50%の濃さ、ON=ロゴ、発話中・文字起こし中=右下に点、エラー=右上に赤い点 (非テンプレート。明暗で描き分け) | デザインの進捗バー・色付き表示は標準メニューで再現できないため |
| 常時表示パネル | フォーカスを奪わないパネル(NSPanel, non-activating。`tauri-nspanel`)。クリック・ドラッグ・右クリックで mukuchi を前面アプリにしない (前面アプリのキーフォーカス・IME の変換中の文字を保つ)。non-activating のスタイルは NSPanel の初期化時にしかウィンドウサーバーに伝わらず (FB16484811)、既存のウィンドウを後から NSPanel にする tauri-nspanel では効かないため、AppKit の非公開 API `_setPreventsActivation:` を作成直後と表示時に呼び、読み返して確認する (応答しない OS ではエラーをログに出す)。既定は画面下中央(Dockの上16px)、ドラッグで移動し位置を記憶。前面ウィンドウのあるディスプレイに表示。ピルはディスプレイの visibleFrame (Dock・メニューバーを除く) に収める。記憶するのは利用者のドラッグだけ(ディスプレイの取り外し等でシステムが動かした位置は記憶しない) | |
| ログイン時に起動 | `SMAppService.mainAppService` (macOS 13+) で登録。登録・解除するのは利用者の操作の時だけ: セットアップ完了時 (その時点の launchAtLogin に揃える) と、完了後に設定を切り替えた時。セットアップ完了前の変更は保存のみ。登録後の status が `enabled` でなければ保存せずエラー (承認待ちなら「ログイン項目」を開く案内)。起動時は登録・解除せず、システム設定での変更 (オフ・削除・オン) を設定に取り込む。開発ビルドはセットアップ完了時・起動時の処理をせず、設定画面で切り替えた時だけ登録・解除する | status の意味は SDK の SMAppService.h: 利用者がシステム設定でオフにすると `requiresApproval`、解除済みは `notRegistered`。起動時に status から推測して登録し直すと利用者の選択を上書きするため | tauri-plugin-autostart の macOS 実装は LaunchAgent (plist をアプリ外に置く) か AppleScript (自動化の許可が要る) のみのため使わない |
| Dock | 通常は非表示(Accessory)。設定・セットアップウィンドウ表示中のみ表示(Regular) | |
| 再度の起動 | 起動中に Finder・Spotlight・Launchpad から開くと (macOS の Reopen) 設定を開く (セットアップ未完了ならセットアップ)。2つ目のプロセス (実行ファイルの直接起動・`open -n`) は `tauri-plugin-single-instance` で既存プロセスに知らせて終了し、同じく設定を開く | メニューバーのアイコンがノッチに隠れ Dock にも出ないと、設定・終了に辿れないため。LaunchServices 経由の起動は2つ目を立てず Reopen になるが、直接起動は防げない |
| 配布 | Developer ID署名 + 公証の .dmg。Mac App Storeは対象外。GitHub Releases で公開 (手動実行の `.github/workflows/release.yml`。版上げ・タグ `desktop-v<X.Y.Z>` の規則は docs/release.md) | サンドボックスではCGEventPost不可、ダウンロードしたPython実行環境の実行はガイドライン2.5.2違反、非公開API (`_setPreventsActivation`) は審査で却下、アプリ内アンインストール不可のため (2026-09-30 再確認) |
| アップデート | `tauri-plugin-updater` (Rust からのみ使う)。GitHub Releases の Latest に添付した `latest.json` を見て、新しい版があれば裏で `.app.tar.gz` を取得し、メニューバー・設定 > このアプリについて に「再起動してアップデート」を出す。押すと .app を置き換えて再起動する。.dmg は新規インストール用のまま (updater は .dmg を扱えない)。詳細は「アップデート」の節 | 2026-10-02 決定。サーバー不要・DMG の自動マウント等を自作しないため。TCC の許可は署名の要件 (Team ID + バンドルID) で判定されるため更新後も残る (TN3127)。同じチームのアプリの自己更新は App Management の確認対象外 (WWDC22 10096)。Sparkle 2 は framework 同梱と個別署名が要り、Tauri 用の実装が小規模なため見送り |
| 実行環境の導入 | アプリは軽量に保ち、初回セットアップでuv(同梱)がPython・依存・モデルを導入 | |
| アンインストール | 設定 > ストレージ の「完全にアンインストール」+ `apps/desktop/scripts/uninstall.sh`。「実行環境とモデルのみ削除」も提供 | |
| 開発環境 | Nix flakes devShell + Makefile + process-compose。monorepo (`apps/desktop`、LP は `apps/web`。LP は SST (`sst.config.ts`) で AWS に公開) で JS/TS は pnpm workspace、Rust は Cargo (`apps/desktop/src-tauri` 単独)、Python は uv | [monorepo-plan.md](plans/monorepo-plan.md) |
| 作らない機能 | 押している間だけ録音するモード、文字起こし履歴、入力完了時の効果音、「取り消し」音声での破棄 | 2026-09-30 決定 |

## 識別子・パス

| | 本番 | 開発 |
|---|---|---|
| バンドルID | `com.minimalcorp.mukuchi` | `com.minimalcorp.mukuchi.dev` |
| データ | `~/Library/Application Support/<バンドルID>/` | 同左 (devのID) |

データディレクトリ配下: `.mukuchi-data`(目印。下記) `settings.json` `provisioned.json` `uv/`(uv のその他の書き込み先: UV_PYTHON_BIN_DIR・UV_TOOL_DIR。同梱 uv のハッシュのキャッシュ `bundled-uv-hash.json` も置く) `python/`(UV_PYTHON_INSTALL_DIR) `venv/`(UV_PROJECT_ENVIRONMENT) `cache/`(UV_CACHE_DIR) `asr-server/`(同梱物のコピー。uv sync のプロジェクト) `models/`(HF_HOME。モデルごとに `hub/models--<org>--<name>/`)。ログは `~/Library/Logs/<バンドルID>/`。アプリ外(`~/.cache` 等)に書き込まない。

削除の安全策:
- 目印 `.mukuchi-data`: 起動時にデータディレクトリを作り (本番・開発とも) 空ファイルを書く。アンインストール・「実行環境とモデルのみ削除」は目印があり `.git` を含まないデータディレクトリだけを消す (無ければ対象から外す・エラー)
- `MUKUCHI_DEV_DATA_DIR` は 絶対パス・`..` を含まない・存在しないか空か目印がある・`.git` を含まない・target ディレクトリ / 同梱物 (asr-server・uv。`MUKUCHI_DEV_*` で差し替えたものを含む) / ホームと同じかその祖先でない (シンボリックリンクは解決して比較) ものだけ受け付ける。満たさなければ起動しない (本物のデータディレクトリに切り替えない)
- asr-server/ のコピーは、コピー元とコピー先が同じか入れ子なら行わない
- 開発ビルドがバンドルIDが `.dev` で終わらない (本番のID) で動いている場合、アンインストールは dry-run に、「実行環境とモデルのみ削除」はエラーにする
- 削除の実行中は `start_provisioning` を無視し `restart_asr` はエラー。アップデートのインストール中 (「アップデート」) も `start_provisioning` を無視する。削除を始める前に導入済みの扱いを外す (削除後は未導入)

アンインストール対象: 上記データディレクトリ、`~/Library/{Caches,Logs,WebKit,HTTPStorages}/<バンドルID>`、`~/Library/Saved Application State/<バンドルID>.savedState`、`~/Library/Preferences/<バンドルID>.plist` (`defaults delete <バンドルID>` で消す。ファイル削除だけでは cfprefsd のキャッシュから書き戻されうる)、ログイン項目、TCC (`tccutil reset All <バンドルID>`。LaunchServices に登録されたアプリが必要なため本体を消す前に行う)、アプリ本体(ゴミ箱へ)。HTTPStorages・Saved Application State は WebKit・AppKit がバンドルIDで作りうるため含める(存在するものだけ消す)。開発版は `tauri dev` の未バンドル実行で WebKit が作る `~/Library/{Caches,WebKit}/mukuchi` も対象。

- ログイン項目: `SMAppService.mainAppService` で登録したもの。ファイルはアプリ外に置かず、システムの Background Task Management (BTM) に記録される(「システム設定 > 一般 > ログイン項目」に表示)。アプリ内のアンインストールでは本体を消す前に `SMAppService.mainApp.unregister` で解除する。`apps/desktop/scripts/uninstall.sh` からは API を呼べないため解除せず、残っていればシステム設定から削除するよう表示する。アプリ本体を消した後に BTM の記録が残るか(自動で消えるか)は未検証 (実機でログイン項目を登録して確かめる必要があり、利用者の環境を変えるため未実施)。`sfltool resetbtm` は他のアプリの項目も消すため使わない
- LaunchAgent (`~/Library/LaunchAgents/*.plist`) は作らない

## 同梱物と初回セットアップ (P4)

### .app に同梱するもの (macos-release-engineer が bundle 設定、rust-engineer は下記パスを前提に実装)

| .app 内の場所 | 内容 |
|---|---|
| `Contents/Helpers/uv` | uv の単一バイナリ (aarch64-apple-darwin。版は devShell の uv と揃え、sha256 を固定して `apps/desktop/scripts/fetch-uv.sh` が取得)。公式リリースは開発元の Developer ID 署名 (0.12.17 は `OpenAI OpCo, LLC (2DC432GLL2)`)・Hardened Runtime・タイムスタンプ付きで公証済みのため、再署名せずそのまま同梱する。Resources ではなく Helpers に置くのは、Apple の "Placing content in a bundle" で helper tool (Mach-O) の置き場所が `Contents/MacOS/` か `Contents/Helpers/` とされ、それ以外に置くと公証で問題になりうるため。`bundle.macOS.files` でコピーするので Tauri は再署名しない (externalBin にすると Tauri が自分の証明書と本体の entitlements で再署名する) |
| `Contents/Resources/asr-server/` | `pyproject.toml` `uv.lock` `.python-version` `src/` (テスト・キャッシュは除く) |
| `Contents/Resources/verify.wav` | 検証用音声 (「確認します。」、Kyoko の合成音声、16kHz/mono/s16、約1.1秒)。リポジトリには置かず、`apps/desktop/scripts/prepare-bundle-resources.sh` がビルド時に `apps/desktop/scripts/make-verify-wav.sh` (`say` + python) で `apps/desktop/.build-cache/` に一度だけ作り `apps/desktop/src-tauri/bundle-resources/` にコピーする |
| `Contents/Resources/THIRD_PARTY_NOTICES`, `licenses/` | ライセンス |

- uv と `apps/desktop/asr-server/` は `apps/desktop/scripts/prepare-bundle-resources.sh` が `apps/desktop/src-tauri/bundle-resources/` (gitignore) に用意する。tauri-build は dev でも resources を要求するため `make setup` と `make build*` から呼ぶ
- Rust からの解決:
  - uv: .app から起動している時 (実行ファイルが `<X>.app/Contents/MacOS/` にある時) は `<実行ファイルのディレクトリ>/../Helpers/uv`。それ以外 (`tauri dev` の未バンドル実行) は `app.path().resolve("bin/uv", BaseDirectory::Resource)` (= `apps/desktop/src-tauri/target/debug/bin/uv`。`tauri.dev.conf.json` が dev の時だけ resources に `bin/uv` を加え、tauri-build がコピーする)。正規化し、実在する実行可能ファイルでなければ起動は続けてログに記録し、セットアップの runtime ステップで「入れ直してください」を表示する。`MUKUCHI_DEV_UV` はデバッグビルドのみ (検査せずそのまま使う)
  - asr-server・verify.wav: `app.path().resolve(..., BaseDirectory::Resource)`。本番は `mukuchi.app/Contents/Resources/`、`tauri dev` は `apps/desktop/src-tauri/target/debug/`
- 本体以外の Mach-O は `Contents/Helpers/uv` だけにする (`make verify` が確認)。署名は `apps/desktop/scripts/build-macos.sh` が .app に `--deep` なしで行い、uv の署名は入れ子のコードとして検証・封印される

### セットアップ手順 (provisioning)

1. **runtime**: `asr-server/` をデータディレクトリへコピーし、同梱 uv で `uv python install <.python-version の版> --no-bin` (引数なしだと最新版も入るため版を明示) → `uv sync --frozen --no-dev --compile-bytecode` で `venv/` を作る。uv には環境変数を引き継がず (`PYTHONPATH` 等の混入防止)、`HOME` `TMPDIR` `LANG`、プロキシ変数 (`HTTP_PROXY` `HTTPS_PROXY` `NO_PROXY` `ALL_PROXY` とその小文字)、`SSL_CERT_FILE` `SSL_CERT_DIR` だけ渡す。`UV_SYSTEM_CERTS=1` で OS の証明書ストアを使う (社内プロキシの独自ルート証明書向け。uv 0.12 で `UV_NATIVE_TLS` は非推奨になりこちらが正)。`UV_PYTHON_INSTALL_DIR` `UV_CACHE_DIR` `UV_PROJECT_ENVIRONMENT` `UV_PYTHON_BIN_DIR` `UV_TOOL_DIR` `UV_TOOL_BIN_DIR` をデータディレクトリ配下に向け、`UV_NO_CONFIG=1` (ユーザーのuv設定を読まない)・`UV_PYTHON_PREFERENCE=only-managed` (システムの Python を使わない)。出力は `~/Library/Logs/<バンドルID>/provisioning.log` (5MB を超えたら `.1` に1世代残す)
2. **model**: 選択中のモデル (新規の導入では既定の `ja-8bit`) を Hugging Face から `models/` (HF_HOME) に取得。リポジトリIDと revision は Rust の定数で固定 (`provisioning/models.rs` の `CATALOG`)。進捗・一時停止・再開(部分ファイルからの再開)は Rust が HTTP で直接取得して実現する。設定画面からのモデルごとの取得 (「モデルの管理」) も同じ処理を使う
   - 一覧は `GET /api/models/<repo>/tree/<revision>?recursive=true`。取得対象は mlx-qwen3-asr と同じ `*.json *.safetensors *.txt *.model`
   - 本体は `GET /<repo>/resolve/<revision>/<path>` を `Range: bytes=<取得済み>-` で続きから取る (リダイレクト先の CDN も Range に対応)。通信の一時的な失敗は3回まで続きから取り直す。206 の `Content-Range` が要求 (`<取得済み>-<size-1>/<size>`) と合わなければ書かずに一時的な失敗として取り直し、200 (Range を無視) なら最初から取り直す。配布ビルドの HTTP クライアントは https のみ (リダイレクト先も)。取得後に LFS は sha256、それ以外は git の blob id (sha1) で検証し、一致しなければ捨てる
   - 書き込み先は huggingface_hub (2.0) のキャッシュと同じレイアウト: `hub/models--<org>--<name>/{blobs/<etag>, blobs/<etag>.incomplete, snapshots/<commit>/<path> → ../../blobs/<etag>, refs/main, trees/<commit>.json}`。`trees/` は revision に commit を指定したオフラインの snapshot_download に必要 (無いとネットワークへ出て失敗する)。取得したファイルだけを載せる
   - 取得の完了時に、同じリポジトリの他の revision のもの (`snapshots/<他>`・`trees/<他>.json`・今の revision から参照されない `blobs/`) を消す (アプリの更新で revision が変わった時に古い版を残さない)
3. **verify**: 本番と同じ起動方法 (下記) でASRサーバーを起動し `/health` と、同梱の短い無音ではない検証用音声 (TTSで作成、`Resources/verify.wav`) で `/transcribe` が成功し結果が空でないことを確認。検証中は自動再起動しない。成功したサーバーはそのまま使い続ける (読み込みをやり直さない)

導入済みの判定は `<データ>/provisioned.json` で行う:

```jsonc
{
  "runtime": { "version": "<sha256>", "completedAt": 1759300000 },
  // 取得を終えたモデル。キーは版 `<repo>@<revision>` (revision が変わると別のキーになり、未取得扱い)
  "models": { "minimalcorp/Qwen3-ASR-1.7B-JA-MLX-8bit@698eff96…": { "completedAt": 1759300000 } },
  // 選択中のモデル (カタログの id)。無ければ起動時に決める (「モデルの管理」の移行)
  "selectedModel": "ja-8bit",
  // 動作確認したときの runtime とモデルの版。model は記録のみ (モデルを切り替えても verify はやり直さない)
  "verify": { "runtime": "<sha256>", "model": "<repo>@<revision>", "completedAt": 1759300000 }
}
```

時刻は UNIX 秒。runtime の版は同梱 uv と `asr-server/` の内容の sha256 (uv のハッシュは大きさ・更新時刻が同じならキャッシュを使う)。旧形式の `model: {version, completedAt}` (モデルが1つだった頃) は読み込み時に `models` へ移し、書き込み時には出さない。セットアップの model は **選択中のモデル** の記録で判定する。記録があっても導入先 (`venv/bin/python`・スナップショットの `config.json`) が無ければやり直す。版が変わった場合は該当ステップとその後の verify のみやり直す (verify は runtime の版が記録と同じで、runtime・model が済んでいれば済み。model をやり直した時は verify もやり直す)。起動時に、セットアップ完了済みで記録 (runtime・models・verify のいずれか。selectedModel だけでは数えない) があるのに版が変わっていれば (アプリの更新) 自動でやり直す (その間 phase は loading)。「実行環境とモデルのみ削除」は記録ごと消すため自動ではやり直さない。**旧版へのダウングレードは想定しない** (旧版は新しい形式の `models`・`selectedModel` を読まず、モデルを未導入とみなして取り直しうる)。`provisioned.json` の読み書きは1か所 (プロセス内のロック) で直列にし、段階ごとに読み直して部分的に書き換える (セットアップとモデルの管理が互いの記録を上書きしないため)

- 一時停止: model は途中のファイルを残し再開時に続きから取る。runtime は uv を止め再開時にやり直す (uv のキャッシュで続きから進む)。verify はやり直す
- 失敗: `ProvisioningStatus.error` に表示用の文言。`start_provisioning` で再試行 (一時停止からの再開と同じ。済んだ段階はやり直さない)

### 本番の ASR サーバー起動

`<データ>/venv/bin/python -m mukuchi_asr --port <空きポート> --model <models/hub/models--<org>--<name>/snapshots/<commit>> --exit-on-stdin-eof` (選択中のモデル) を stdin をパイプにして起動。環境変数は引き継がず `HOME` `USER` `LOGNAME` `TMPDIR` `LANG` `LC_*` と `PATH=/usr/bin:/bin:/usr/sbin:/sbin` `HF_HOME` `HF_HUB_OFFLINE=1` `HF_HUB_DISABLE_TELEMETRY=1` `PYTHONNOUSERSITE=1` `PYTHONSAFEPATH=1` だけ渡す。作業ディレクトリは `venv/` (cwd のファイルを import しない)。セットアップの動作確認で起動した場合は `/transcribe` の確認が済むまで準備完了 (asrReady) にしない。stdout/stderr は `~/Library/Logs/<バンドルID>/asr-server.log` へ (5MB を超えたら `.1` に1世代残す)。`/health` が応答するまで phase は loading (上限10分)。異常終了時は3回まで自動再起動 (10分以上動いた後の異常終了は数え直す)。使い切ったら `asr_stopped`。`restart_asr` は止めてから起動し直す。アプリ終了時は実行中のセットアップ (uv・ダウンロード・動作確認) を止めて最大3秒待ち、stdin を閉じてサーバーを止める (3秒で終わらなければ kill)。未導入なら `runtime_missing` (action `start_setup`)

### モデルの管理

| id | リポジトリ@revision | 容量 (取得するファイルの合計) | |
|---|---|---|---|
| `ja-8bit` | `minimalcorp/Qwen3-ASR-1.7B-JA-MLX-8bit@698eff963b084561b12a045c95bc4a208898337f` | 2,185,804,096 B (約2.2GB) | 既定・推奨 (`recommended`)。新規のセットアップで取得する |
| `ja-bf16` | `neosophie/Qwen3-ASR-1.7B-JA@987bda160f2dabfa6757550bcff7cdda2ba0648c` | 4,092,092,275 B (約4.1GB) | 元の bf16 版。**旧候補** (`legacy`): 手元にある導入でのみ出す (下の「旧候補」) |

容量は固定した revision の tree API の値 (取得対象 `*.json *.safetensors *.txt *.model` の合計)。表示名・説明も同じ定数に持ち `list_models` で返す。

- **旧候補** (2026-10-02 決定): 新規に選べる候補は既定の `ja-8bit` のみ。`legacy` の候補は、選択中か取得中か手元にファイル (そのモデルのディレクトリ。取得済み・途中・古い revision を含む) がある時だけ `list_models` に出し、それ以外 (`not_downloaded` かつ選択中でない) は出さない。出ていない旧候補への `download_model`・`select_model`・`delete_model`・`cancel_model_download` は「不明なモデルです」。既に使っている人はそのまま使い続けられ、削除すると一覧から消える (再取得はできない)。複数モデルの取得・選択・削除の仕組みは残す (今後候補を足すため)。一覧が1件の時は使用中の行に削除ボタンを出さない (切り替え先が無いため)

- **選択**: 選択中のモデルは `provisioned.json` の `selectedModel` に記録する (`Settings` には置かない。「取得済みのものだけ選べる」は導入の記録と一緒に保つ必要があり、「実行環境とモデルのみ削除」で記録ごと既定に戻るため)。`select_model` は取得済み (現在の revision の記録があり `config.json` がある) のモデルだけ受け付け、ASR サーバーを新しいモデルで起動し直す (音声入力は OFF になり phase は loading を経由)。準備完了 (`/health`) まで待ち、**準備完了してから選択を記録して** 返る (切り替えの途中でアプリが終わっても、読み込めるか分からないモデルを選択中に残さない。その間 `ModelInfo.selected` は元のモデルのまま)。切り替えの起動は自動再起動なしで行い、準備完了したら自動再起動を有効にする
- **切り替えの失敗**: 新しいモデルでサーバーが準備完了にならなければ (異常終了・読み込みの上限10分)、元のモデル (選択は元のまま) で起動し直し (自動再起動あり)、エラーで reject する (「『<新>』を読み込めませんでした。『<元>』に戻しました」)。新しいモデルの異常終了は `asr_stopped` にしない (元のモデルの読み込み中に停止エラーを出さないため)。準備完了後に選択を記録できなかった場合も元のモデルに戻して reject する。元のモデルでも起動できなければ通常の `asr_stopped`
- **切り替え中**: `select_model`・`delete_model`・`restart_asr`・`delete_runtime_and_model`・`uninstall` はエラー (「モデルを切り替え中です」。失敗時に元のモデルを起動し直す処理と重ねないため)。アップデートのインストール中 (再起動待ちを含む) も同じ操作と `download_model` はエラー (「アップデートをインストールしています」)
- **取得**: モデルごとに開始・一時停止・再開・中止。処理はセットアップの model と同じ (`hf.rs`。部分ファイルからの再開・検証・huggingface_hub 互換のレイアウト)。同時に取得するのは1つ (他が取得中なら `download_model` はエラー)。一時停止・失敗で止まったものは複数残ってよい。完了したら `models` に記録する (選択は変えない)。中止 (`cancel_model_download`) は途中のファイルごとそのモデルのディレクトリを消す (削除と同じく、開発ビルドが本番のバンドルIDで動いている時は拒む)
- **削除**: `delete_model` は選択中・取得中のモデルを拒む。記録を先に消してから `models/hub/models--<org>--<name>/` を消す (データディレクトリの目印を確かめる。開発ビルドが本番のバンドルIDで動いている時は拒む)。ディレクトリの削除中 (中止を含む) はそのモデルの取得・削除を拒む
- **利用できる時**: モデルの操作 (`select_model`・`download_model`・`delete_model` 等) はセットアップ完了後 (`ProvisioningStatus.stage` が `done`) のみ。それ以外・削除の実行中はエラー。セットアップの取得は `ProvisioningStatus` で表し、`list_models` には手元のファイルの状態だけが出る
- **移行** (起動時): `selectedModel` が無い・カタログに無い・そのモデルの記録 (どの revision でも) かディレクトリが無い場合は、既定 (`ja-8bit`) が記録ありならそれ、無ければ記録のある他のモデル (カタログ順)、どれも無ければ既定を選ぶ。記録 (runtime・models・verify) があれば `selectedModel` を書き込む。つまり **bf16 だけ導入済みの既存の導入は bf16 を選択中として残し、8bit を自動では取得しない** (2GB 超の取得を利用者の操作なしに始めないため)。8bit への切り替えは設定画面から (取得 → 選択)
- **revision が変わった時** (アプリの更新): 選択中のモデルは起動時にセットアップの自動やり直しで取り直す (上記)。選択中でないモデルは記録が合わないため取得済みではなくなり、古いファイルが残っていれば `paused` と表示する (`download_model` で新しい revision を取る。同じファイルは取り直さない。完了時に古い版を消す)
- **ストレージ**: `StorageUsage.modelBytes` は `models/` 全体 (全モデル・取得途中を含む)。モデルごとの量は `ModelInfo.diskBytes`。「実行環境とモデルのみ削除」は取得中のモデルを止めてから全モデルを消し、選択を既定に戻す (記録ごと消えるため)。アンインストールも取得を止めてから消す
- **開発** (`MUKUCHI_ASR_URL` 使用中): `select_model` は記録の書き換えのみ (外部のサーバーは起動し直さない。使うモデルは process-compose 側で決まる。既定は ja-8bit と同じ版で、`Makefile` の `MUKUCHI_MODEL`・`MUKUCHI_MODEL_REVISION`)。**設定画面の選択・表示は実際に使っているモデルと食い違いうる** (例: 以前に bf16 でセットアップした dev データでは bf16 が選択中のまま)。`make setup` (`apps/desktop/scripts/setup.sh`) は取得したモデルを、アプリのセットアップ済み (`runtime` の記録がある) の dev データに限り `models` に記録する (8bit が「一時停止中」ではなく取得済みに見えるように。選択は変えない。記録が無い・`make reset PROVISION=1` の後はアプリのセットアップが取得・記録する)
- エラー (reject の文言): 不明な id「不明なモデルです」、セットアップ未完了「セットアップが完了していません」、削除の実行中「削除を実行中です」、他が取得中「他のモデルをダウンロード中です」、未取得を選択「ダウンロードが済んでいないモデルは選べません」、選択中を削除「使用中のモデルは削除できません」、取得中を削除「ダウンロード中のモデルは削除できません。中止してください」、取得済みを中止「ダウンロード済みです」、切り替え中「モデルを切り替え中です」、アップデートのインストール中「アップデートをインストールしています」、ディレクトリの削除中「モデルを削除しています」、開発ビルドが本番のバンドルIDで削除・中止「開発ビルドを本番のバンドルIDで実行しているため削除しません」。取得の失敗は reject せず `ModelInfo.error` (文言はセットアップの model と同じ)

### アンインストール (アプリ内)

`uninstall` の順序: (本番) 実行中のアプリ本体の場所が分からない・App Translocation (パスに `/AppTranslocation/` を含む。`SecTranslocateIsTranslocatedURL` は公開ヘッダにないため使わない) なら何も消さずにエラー (「アプリケーション」フォルダへの移動を促す) → 音声入力OFF・セットアップ停止 (削除中の扱い)・ASR停止 → ログイン項目の解除 → ファイル削除 (上記対象のうち存在するもの。名前にバンドルIDを含む・`~/Library` 配下かデータディレクトリ (目印あり) であることを確かめてから消す) → `defaults delete <バンドルID>` → `tccutil reset All <バンドルID>` → アプリ本体を `NSFileManager.trashItemAtURL` でゴミ箱へ → 終了。途中で失敗しても残りは続け、本体をゴミ箱に入れられなかった場合はエラーを返して終了しない。開発ビルドでは target ディレクトリ外のアプリ本体は対象にしない

- `mukuchi.app/Contents/MacOS/mukuchi --unregister-login-item`: ログイン項目 (SMAppService) を解除して終了する (UI は起動しない。終了コード 0=成功 1=失敗)。`apps/desktop/scripts/uninstall.sh` が本体をゴミ箱に入れる前に呼ぶ
- `mukuchi.app/Contents/MacOS/mukuchi --print-uv-path`: 解決した同梱 uv のパス (正規化済み) を表示して終了する (隠しフラグ。UI は起動しない。終了コード 0=成功 1=見つからない・実行できない)。リリースビルドは `MUKUCHI_DEV_*` を無視するため、ビルドした .app が `Contents/Helpers/uv` を指すかの確認に使う

### アップデート

- 配信: Release `desktop-v<X.Y.Z>` に `mukuchi_aarch64.app.tar.gz` (公証・staple 済みの .app。最上位は `mukuchi.app/`) と `latest.json` を添付する (作り方は docs/release.md)。endpoint は `https://github.com/minimalcorp/mukuchi/releases/latest/download/latest.json` 固定 (web は GitHub Release を作らないため Latest は常に desktop)。`latest.json` の url は版付きの `releases/download/desktop-v<X.Y.Z>/...` (Latest が途中で変わっても版と中身がずれない)
- 署名: minisign (tauri の updater 鍵)。公開鍵は `tauri.conf.json` の `plugins.updater.pubkey`、秘密鍵は Environment `production-desktop` の secret のみ。`requireSignedVersion: true` (署名の trusted comment の版と `latest.json` の版が一致しなければ拒否。古い署名済みファイルへの巻き戻し防止)。**鍵を失うと既存の利用者に更新を届けられない**
- 対象: 本番ビルドのみ。開発ビルドは確認・取得・インストールをしない (`UpdateStatus.state` = `unavailable`)。ただしデバッグビルドで `MUKUCHI_DEV_UPDATE_ENDPOINT=<url>` があれば確認・取得まで行う (http 可。インストールは常にしない。UI の確認用)
- 場所の確認: 実行中の .app のパスに `/AppTranslocation/` を含む、または `/Volumes/` 配下 (dmg から直接起動) なら確認・取得をせず `unavailable` (理由「アプリケーションフォルダに移動すると自動でアップデートできます」)。書き込めない場所 (他の管理者が入れた等) は updater が管理者のパスワードを求める
- 確認の時期: セットアップ完了後、`Settings.autoCheckUpdates` が true なら起動30秒後と、前回の確認から6時間ごと (10分ごとに経過を見る。スリープ明けにも追いつく)。`check_for_update` (手動) は設定によらずいつでも。同時に1つだけ (確認・取得中の再要求は何もしない)
- 取得: 新しい版が見つかれば続けて取得する (約40MB。取得したものはメモリに保持し、アプリを終了すると捨てる。次の起動で取り直す)。署名の検証は取得時に updater が必ず行う。取得済み (`ready`) の後の確認で、取得済みより新しい版 (semver で比較) があれば取り直す。同じか古い版 (Latest の取り下げ等) なら取得済みを残す
- インストール (`install_update`): `ready` の時のみ。`ready` のまま裏で確認・取り直しをしている間はそれが終わるのを待ち、終わった時点で `ready` なら進める (そうでなければ「インストールできるアップデートがありません」)。`ready` でない確認・取得中はエラー (「アップデートを確認しています。しばらくしてからもう一度お試しください」)。セットアップ・モデルの取得・切り替え・削除・アンインストールの実行中はエラー (「ダウンロード・削除の実行中は更新できません」)。インストール中 (`installing`、置き換え後の再起動待ちを含む) は `start_provisioning` を無視し、`download_model`・`select_model`・`delete_model`・`restart_asr`・`delete_runtime_and_model`・`uninstall` をエラーにする (「アップデートをインストールしています」)。音声入力を OFF にしてから updater の install (.app を一時領域に退避して置き換える) → `AppHandle::request_restart` (`RunEvent::Exit` で ASR を止めてから起動し直す)。install に失敗したら `error` にして再起動しない
- 表示: `ready` の間、メニューバー (とパネルの右クリックメニュー) の「設定…」の上に「再起動してアップデート (v<X.Y.Z>)」を出す (`install_update` と同じ処理。失敗はメニューの通知と同じくログと設定の表示のみ)。設定 > このアプリについて に状態・「アップデートを確認」・「再起動してアップデート」・自動確認の切り替え (`autoCheckUpdates`) を置く。macOS の通知 (通知の許可) は使わない
- 更新後の起動: 同梱物の版が変わっていれば既存の仕組み (「セットアップ手順」の版の判定) が実行環境を入れ直す
- 失敗 (確認・取得・インストール) はログに出し `error` (表示用の文言は日本語)。自動の確認での失敗はメニューバーに出さない (設定の「このアプリについて」にだけ出す)
- 既知の制約 (tauri-plugin-updater 2.13): インストールにロールバックはなく、最後の置き換えに失敗すると .app が残らないことがある (plugins-workspace#3505)。更新後の .app の権限が 0700 になり他のユーザーが起動できないことがある (#3506)

## インターフェース

変更する場合は先にここを更新し、関係するsubagentに周知する。

### ASRサーバー HTTP API (asr-server ↔ Rust)

- 待受: `127.0.0.1:<port>`。本番はRustが空きポートを選び `--port` で渡し、`--exit-on-stdin-eof` 付きで起動する。開発は `18765` 固定でprocess-composeが起動し、アプリは環境変数 `MUKUCHI_ASR_URL` があればそれに接続する(自分では起動しない)
- `GET /health` → `200 {"status":"ok","model":"<id>"}`。モデル読み込み完了まで応答しない
- `POST /transcribe` — body: 16kHz/mono/16bit PCMのWAV (`Content-Type: audio/wav`)。query: `language` (既定 `Japanese`)、`context` (認識のヒント = `Settings.asrContext` をそのまま。任意。Qwen3-ASR のシステムメッセージにそのまま入る) → `200 {"text":"...","elapsed_ms":123}`
  - `elapsed_ms`: サーバーがbodyを受信し終えてから応答するまでの時間 (WAVデコード + 推論待ち + 推論)。ネットワーク転送は含まない
  - エラー: 不正なWAV/形式違い → `400`、body が 5MiB (約120秒分+余裕) を超える → `413`
- 開発用 (デバッグビルドのみ): `MUKUCHI_DEV_AUDIO_FILE=<wav>` でマイクの代わりにWAVを実時間で流す (その後は無音)。`MUKUCHI_DEV_AUTO_LISTEN=1` でASR準備完了後に自動でONにする (セットアップ画面は開かない)。`MUKUCHI_ASR_URL` 使用中はセットアップ不要とみなし、起動時にセットアップを開かずpanelを表示する (トレイの「セットアップを開く…」からは開ける)。`MUKUCHI_DEV_SHOW_SETUP=1` でそれをやめ本番と同じ判定にする (セットアップ画面の確認用)。`MUKUCHI_DEV_TARGET_BUNDLE=<bundle id>` でそのアプリが前面の時だけ入力する (自動テストで他のアプリに入力しないため)。`MUKUCHI_DEV_NO_PARTIAL=1` で途中表示を送らない (遅延の比較用)。`MUKUCHI_ASR_URL` もデバッグビルドのみ有効で、ループバックの http のみ受け付ける。`MUKUCHI_DEV_DATA_DIR=<dir>` でデータディレクトリを差し替える (本物のデータ・モデルに触れずに検証するため。受け付ける条件は「識別子・パス」の削除の安全策)。`MUKUCHI_DEV_UV` `MUKUCHI_DEV_ASR_SERVER_DIR` `MUKUCHI_DEV_VERIFY_WAV` で同梱物 (uv・asr-server/・verify.wav) を個別に差し替える。`MUKUCHI_DEV_UNINSTALL_DRY_RUN=1` でアンインストールは何も消さず対象と操作をログに出すだけ (アプリも終了しない)
- 推論は直列実行 (MLXはスレッド束縛のため、読み込み・ウォームアップ・全推論を専用の1スレッドで行う)。無音由来の定型ハルシネーション除外はサーバー側で行う
- リアルタイムプレビューも同じ `/transcribe` を使う(専用APIは設けない)

### Tauri commands / events (Rust ↔ フロントエンド)

型はRust側を正とし、`apps/desktop/src/lib/ipc.ts` にTypeScript型を手書きで同期する。名前はRustがsnake_case、JSONのフィールドはcamelCase (`#[serde(rename_all = "camelCase")]`)。ウィンドウのlabelは `panel` / `settings` / `setup`。

#### 型

```ts
type Phase = "loading" | "off" | "listening" | "speaking" | "finalizing" | "done" | "error";

type AppStatus = {
  phase: Phase;
  // phase=loading: モデル読み込み・ASR起動中。進捗が取れない場合は null (不定表示)
  loadingProgress: number | null;
  error: AppError | null;
  // 状態が変わるたびに1ずつ増える通番。受け手は手元より小さい seq の status-changed / get_status の結果を捨てる
  seq: number;
};

type AppError = {
  code: "accessibility_denied" | "microphone_denied" | "microphone_missing"
      | "asr_stopped" | "runtime_missing" | "insert_failed"
      | "vad_failed";   // 発話検出 (VAD) を初期化できない。表示「発話検出を開始できません」、action は null
  message: string;   // 表示用 (日本語)
  // 復旧操作。メニュー・パネルのボタンに対応
  action: "open_accessibility" | "open_microphone" | "select_microphone"
        | "restart_asr" | "start_setup" | null;
};

type Utterance = {
  id: number;
  text: string;
  stableLength: number;  // 前回の途中表示との共通接頭辞の長さ (UTF-16 コード単位 = JS の length/slice と同じ)。プレビューの表示には使わない (フロントエンドが前回の text と単語単位で差分を取る)
};

type UtteranceResult =
  | { kind: "inserted"; id: number; text: string; appName: string }
  | { kind: "command"; id: number; text: string; key: string }        // key 表示用 例 "Enter" "⇧+Enter" "⌘+Enter" (修飾は ⌃⌥⇧⌘ の順)
  | { kind: "skipped_excluded"; id: number; text: string; appName: string }
  | { kind: "empty"; id: number }                                     // 認識結果が空
  | { kind: "discarded"; id: number }                                 // 短すぎる発話(誤検出) / 発話中にOFF
  | { kind: "failed"; id: number; text: string; error: AppError };

type Settings = {
  launchAtLogin: boolean;                 // 既定 true。セットアップ完了前は保存のみで complete_setup で反映。完了後の変更は SMAppService で登録・解除し、有効にならなければ保存せずエラー。起動時にシステム設定での変更を取り込む (「決定事項」)
  inputDeviceId: string | null;           // null=システム既定。選択したマイクがつながっていない間は設定を残したままシステム既定で録音し、つながったら戻す
  vadSensitivity: number;                 // 0..100 既定 60
  silenceMs: number;                      // 300..3000 既定 1300 (話の途中の間で分割しないため長め)
  voiceCommandsEnabled: boolean;          // 既定 true
  voiceCommands: { id: string; phrases: string[]; key: KeyCombo }[]; // 言い方のないコマンド・正規化(NFKC・記号空白除去・小文字化)後に空/重複する言い方は update_settings がエラーにする
  asrContext: string;                     // 既定 ""。認識のヒント (自由記述)。前後の空白を除いて ASR の context にそのまま渡す (空なら渡さない)。最大 1000 文字 (Unicode スカラー値で数える。超えたら update_settings は保存せずエラー。context は URL のクエリで送り、uvicorn (h11) のリクエスト行+ヘッダーの上限 16KiB に日本語の URL エンコード (1文字9バイト) で収めるため。長いほど毎回の推論も遅くなる)。旧形式の vocabulary: string[] だけがある設定は、読み込み時に空白区切りでつないで asrContext に移す (それまでと同じ context になる)
  excludedApps: { bundleId: string; name: string }[];
  panelPosition: { x: number; y: number; displayId: string; version: 2 } | null; // null=既定位置。Rust (ドラッグ) だけが書く (フロントエンドは null にするだけ)。x,y はピル (影の余白を除いた描画内容) のアンカー点の、ディスプレイ左下からの位置 (整数pt、y上向き)。アンカー点はアンカー (panel-anchor) に当たるピルの辺・角 (例: 右上なら右上の角、中央下なら下辺の中央) で、アンカーはこの点の visibleFrame 内の位置 (左右3等分・上下2等分) から決まる。displayId は CGDirectDisplayID (ピルの中心があるディスプレイ)。version なし (旧形式: ウィンドウの下端中央) は起動時に Rust が見た目の位置を変えずに移行して保存し直す。大きさの変更で画面に収めるための自動のずれは保存しない
  setupCompleted: boolean;
  panelStyle: "full" | "compact";         // 既定 "full"。compact はマイクの円形ボタンのみ (プレビュー・文言なし)
  inputMode: "continuous" | "oneShot";    // 既定 "continuous" (「決定事項」の入力モード)。未知の値は既定として読む
  autoCheckUpdates: boolean;              // 既定 true。自動でアップデートを確認・取得する (「アップデート」)。false でも手動の確認はできる
  shortcut: string | null;                // 既定 "Alt+Space"。null=無効。形式は「修飾+…+キー」: 修飾は Ctrl・Alt・Shift・Cmd をこの順で1つ以上、キーは KeyboardEvent.code (例 "Space" "KeyM" "Digit1" "F5")。登録できなければ (形式の誤り・OS が拒否) update_settings は保存せずエラー。他アプリが同じキーを使っていても登録は成功しうる (global-hotkey 0.8 は非排他で `RegisterEventHotKey` するため衝突を検出できない。どちらに届くかは未確認)
};
type ShortcutStatus = { shortcut: string | null; registered: boolean; error: string | null }; // error: 起動時などに登録できなかった時の表示用 (日本語)
type KeyCombo = { key: "enter" | "tab" | "escape" | "backspace"; modifiers: ("cmd" | "shift" | "option" | "ctrl")[] };

type Permissions = {
  microphone: "granted" | "denied" | "not_determined";
  accessibility: boolean;
};

type ProvisioningStatus = {
  stage: "idle" | "runtime" | "model" | "verify" | "done" | "paused" | "error";
  // 常に runtime, model, verify の順の3件。paused・error の時、止まった項目は "active" のまま
  // bytesTotal: model はファイル一覧の取得後に決まる (再開時は取得済みの分が bytesDone に入る)。runtime・verify は大きさが分からないため常に null
  items: { id: "runtime" | "model" | "verify"; state: "pending" | "active" | "done"; bytesDone: number; bytesTotal: number | null }[];
  bytesDone: number;          // 全体 = bytesTotal の分かる項目 (model) の合計
  bytesTotal: number | null;
  etaSeconds: number | null;  // model の取得中のみ (直近10秒の速度から。最初の2秒は null)
  error: string | null;       // stage=error の時の表示用 (日本語)
};

type StorageUsage = { runtimeBytes: number; modelBytes: number; otherBytes: number }; // modelBytes は models/ 全体 (全モデル・取得途中を含む)

type ModelState = "not_downloaded" | "downloading" | "paused" | "error" | "downloaded";
type ModelInfo = {
  id: string;               // カタログの id ("ja-8bit" | "ja-bf16")。list_models はカタログ順 (表示もこの順)。旧候補 (ja-bf16) は手元にある時だけ出る
  name: string;             // 表示名
  description: string;      // 説明 (1文程度)
  sizeBytes: number;        // 取得するファイルの合計 (固定した revision の値)。進捗の分母・「約 2.2 GB」の表示に使う
  recommended: boolean;     // 既定・推奨 (新規のセットアップで取得するもの)。ちょうど1つ
  selected: boolean;        // 使用中。常にちょうど1つ (選択中は downloaded。ただしセットアップ未完了の間は未取得のことがある)
  state: ModelState;
  // downloading・paused・error: 取得済みのバイト数 (起動し直した後の paused は手元のファイルからの目安)。
  // downloaded: sizeBytes。not_downloaded: 0
  bytesDone: number;
  etaSeconds: number | null; // downloading のみ (直近10秒の速度から。最初の2秒は null)
  error: string | null;      // state=error の時の表示用 (日本語)。再試行は download_model
  diskBytes: number;         // このモデルのディスク上の使用量 (取得途中・古い版を含む)
};
type AudioDevice = { id: string; name: string; isDefault: boolean };
type AppInfo = { version: string; build: string };
type UpdateStatus = {
  // unavailable: 開発ビルド・dmg から起動・App Translocation (「アップデート」)。idle: 未確認か最新
  state: "unavailable" | "idle" | "checking" | "downloading" | "ready" | "installing" | "error";
  currentVersion: string;
  latestVersion: string | null;   // 見つかった新しい版 (downloading・ready・installing、取得・インストールの失敗時)。最新なら null
  notes: string | null;           // latest.json の notes (無ければ null)
  bytesDone: number;              // downloading のみ意味がある
  bytesTotal: number | null;      // 大きさが分からなければ null
  checkedAt: number | null;       // 最後に確認が成功した時刻 (UNIX 秒。このプロセスでの値。永続化しない)
  error: string | null;           // error・unavailable の時の表示用 (日本語)
};
type SettingsCategory = "general" | "voice" | "commands" | "recognition" | "permissions" | "storage" | "about";
```

#### commands

エラー時は表示用メッセージ(日本語の文字列)で reject する。

| command | 引数 → 戻り値 | 用途 |
|---|---|---|
| `get_status` | → `AppStatus` | 初期表示 |
| `set_listening` | `{ on: boolean }` → `()` | パネル・メニューのON/OFF (oneShot でも同じ。ONにすると1発話で OFF に戻る) |
| `get_shortcut_status` | → `ShortcutStatus` | ショートカットの登録状態 (設定・セットアップでの警告表示) |
| `set_shortcut_suspended` | `{ suspended: boolean }` → `()` | ショートカットの記録中に登録を一時解除する (記録中に押したキーで ON/OFF しないため)。記録の終了・取り消し・ウィンドウを閉じた時に false で戻す |
| `get_settings` / `update_settings` | → `Settings` / `{ patch: Partial<Settings> }` → `Settings` | 設定の読み書き(即時保存・即時反映。感度・無音時間は録音中も約0.5秒以内に反映、マイクの変更は録音をやり直す) |
| `list_input_devices` | → `AudioDevice[]` | マイク選択 |
| `get_permissions` | → `Permissions` | 権限表示(setupでは1秒ごとに再取得) |
| `request_microphone` | → `Permissions` | マイク許可ダイアログを出す |
| `open_system_settings` | `{ pane: "microphone" \| "accessibility" \| "login_items" }` → `()` | システム設定を開く。`login_items` はログイン項目 (`SMAppService.openSystemSettingsLoginItems`。launchAtLogin を ON にできなかった時の案内用) |
| `restart_asr` | → `()` | エラーからの復旧 (選択中のモデルで起動し直す。モデルの切り替え中はエラー) |
| `get_provisioning_status` | → `ProvisioningStatus` | |
| `start_provisioning` / `pause_provisioning` | → `()` | ダウンロード開始・再開・失敗後の再試行 (実行中・完了済み・削除やアップデートのインストールの実行中なら何もしない) / 一時停止 (止まるまで待って返る) |
| `get_storage_usage` | → `StorageUsage` | runtime = python・venv・uv・cache・asr-server、model = models (全モデル)、other = settings.json・provisioned.json・ログ (ディスク上の使用量) |
| `delete_runtime_and_model` | → `()` | 実行環境とモデルのみ削除 (セットアップ一時停止・モデルの取得の停止・ASR停止の後。全モデルを消す。設定・ログは残す)。以後 provisioning は idle、status は `runtime_missing`、モデルの選択は既定 (`models-changed` を送る) |
| `list_models` | → `ModelInfo[]` | モデルの一覧 (カタログ順。旧候補は手元にある時だけ。「モデルの管理」の旧候補) |
| `select_model` | `{ id: string }` → `()` | 使うモデルを切り替える (取得済みのみ)。ASR を新しいモデルで起動し直し、準備完了まで待って選択を記録してから返る。失敗したら元のモデルに戻してエラー (「モデルの管理」)。選んだモデルが既に選択中なら何もしない |
| `download_model` | `{ id: string }` → `()` | 取得の開始・一時停止からの再開・失敗後の再試行。開始したらすぐ返る (進捗は `models-changed`)。取得済み・取得中なら何もしない。他のモデルが取得中ならエラー |
| `pause_model_download` | `{ id: string }` → `()` | 一時停止 (止まるまで待って返る)。途中のファイルは残す。取得中でなければ何もしない |
| `cancel_model_download` | `{ id: string }` → `()` | 中止。取得中なら止めてから、途中のファイルを消して `not_downloaded` にする。取得済みならエラー (削除は `delete_model`)。開発ビルドが本番のバンドルIDで動いている時はエラー |
| `delete_model` | `{ id: string }` → `()` | 取得済み (または paused・error) のモデルを消して `not_downloaded` にする。選択中・取得中はエラー |
| `get_uninstall_targets` | → `{ path: string; bytes: number }[]` | 確認ダイアログの一覧 (存在するものだけ。bytes はディスク上の使用量) |
| `uninstall` | → `()` | 完全にアンインストール(完了後にアプリ終了) |
| `list_running_apps` | → `{ bundleId: string; name: string }[]` | 入力しないアプリの追加候補 |
| `open_logs_folder` | → `()` | Finderで開く |
| `get_app_info` | → `AppInfo` | |
| `get_update_status` | → `UpdateStatus` | 設定の「このアプリについて」の初期表示 |
| `check_for_update` | → `UpdateStatus` | 手動の確認。確認が終わった時点の状態を返す (新しい版があれば取得を始めて `downloading`)。`unavailable` ならそのまま返す。確認・取得・インストール中なら何もせず今の状態を返す |
| `install_update` | → `()` | `ready` の時にインストールして再起動する (成功すると返らずに再起動)。`ready` でなければエラー「インストールできるアップデートがありません」(確認・取得中は「アップデートを確認しています…」。`ready` のまま裏で確認中なら終わるまで待つ)。ダウンロード・削除の実行中はエラー (「アップデート」) |
| `open_settings` | `{ category?: SettingsCategory }` → `()` | 設定ウィンドウを開く(開いていれば前面に出し `settings-navigate` を送る)。エラー復旧から該当カテゴリを開く |
| `set_panel_size` | `{ width: number; height: number }` → `()` | panelの描画内容(影の余白込み。余白は左右24・上16・下32pt固定)の大きさ。Rustはpanelウィンドウをこの大きさにし(透明部分がクリックを奪わないようにするため)、アンカー (`panel-anchor`) の辺・角を固定して広げる/縮める。ピル・カード(余白を除いた部分)が visibleFrame (メニューバー・Dockを除く) からはみ出す分だけずらし(余白ははみ出してよい)、小さく戻れば利用者の位置に戻る |
| `get_panel_anchor` | → `{ horizontal: "left" \| "center" \| "right"; vertical: "top" \| "bottom" }` | 現在のアンカー (`panel-anchor` と同じ形)。panel の読み込み直後に呼ぶ (作成直後のイベントは購読前に送られるため)。位置が決まる前は center/bottom |
| `complete_setup` | → `()` | セットアップ完了。launchAtLogin をログイン項目に反映し (本番ビルドのみ。登録できなければ launchAtLogin を false にして完了する)、panelを表示してsetupウィンドウを閉じる |
| `open_setup` | → `()` | セットアップウィンドウを開く(エラー `start_setup` の復旧・実行環境の再導入) |
| `show_panel` | → `()` | panelを表示する (表示中なら何もしない)。setupの「試しに話してみてください」ステップに入った時に呼ぶ。起動時、setupCompleted が false ならpanelは作るだけで表示しない (setupを閉じても非表示のまま。メニューバーの「セットアップを開く…」で再開できる)。ONにした時 (メニューバー等から) もRustがpanelを表示する |
| `show_panel_menu` | `{ x: number; y: number }` → `()` | panelの右クリック。メニューバーとほぼ同じ内容のmacOS標準メニュー (違い: 音声入力のオン・オフは出さず (パネルのボタンで切り替えるため)、代わりにチェック項目「コンパクト表示」(`Settings.panelStyle` を切り替える) を出す) を、panelウィンドウ内の座標 (論理px、左上原点。MouseEvent の clientX/clientY をそのまま渡す) に表示する (メニューバーのアイコンがノッチで隠れても操作できるようにするため)。メニューが閉じるのを待たずに戻る。項目の選択はメニューバーと同じ処理になる |

#### events (Rust → 全ウィンドウ)

| event | payload | 頻度・備考 |
|---|---|---|
| `status-changed` | `AppStatus` | 状態遷移時 |
| `audio-level` | `{ level: number; threshold: number; speech: boolean }` (0..1) | ON中のみ、約15Hz (VADフレーム2つごと)。levelはRMSを表示用に正規化、thresholdは感度から求めたしきい値の位置 |
| `utterance-started` | `{ id: number }` | 発話検出。前の発話の確定処理中に次の発話が始まることがある(idで区別) |
| `utterance-partial` | `Utterance` | リアルタイムプレビュー |
| `utterance-result` | `UtteranceResult` | 最終結果と入力結果 |
| `settings-changed` | `Settings` | 他ウィンドウからの変更の反映 |
| `settings-navigate` | `{ category: SettingsCategory }` | settingsウィンドウ宛。表示中のカテゴリを切り替える |
| `panel-anchor` | `{ horizontal: "left" \| "center" \| "right"; vertical: "top" \| "bottom" }` | panel宛。大きさが変わる時にウィンドウのどの辺・角を固定して広げるか。フロントエンドは描画内容をこの基準に寄せて配置する (例: top なら上端から下へ広がる、right なら右端から左へ)。ピルの中心が visibleFrame の左1/3なら left・右1/3なら right・他は center、上半分なら top・他は bottom。変わった時 (ドラッグ中を含む) と panel 作成直後に送る。変わる時は新しいフレームを設定する前に送る。読み込み直後は `get_panel_anchor` で取る |
| `permissions-changed` | `Permissions` | 権限の変化を検知した時 |
| `shortcut-status-changed` | `ShortcutStatus` | ショートカットの登録状態が変わった時 (起動時の登録・変更・一時解除からの復帰) |
| `input-devices-changed` | `AudioDevice[]` | マイクの接続・取り外し・既定の変更を検知した時 (2秒ごとのポーリング。settings/setup を開いている間か ON の間のみ) |
| `provisioning-progress` | `ProvisioningStatus` | 実行中は変化があれば約4Hz。段階の変化 (開始・完了・一時停止・失敗) は即時 |
| `update-status-changed` | `UpdateStatus` | 状態が変わった時は即時。取得中は約4Hz |
| `models-changed` | `ModelInfo[]` | モデルの状態・選択が変わった時は即時 (取得の開始・完了・一時停止・失敗・中止・削除・選択、セットアップの完了、実行環境とモデルのみ削除)。取得中は変化があれば約4Hz |
