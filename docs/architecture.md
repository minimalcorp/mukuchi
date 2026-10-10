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
| 対象OS | macOS (Apple Silicon, aarch64) と Windows 11 (x64)。Windows の設計は「Windows 版」の節 | MLXがApple Silicon専用のため Mac は MLX、Windows は llama.cpp (2026-10-05 決定。docs/plans/windows-plan.md) |
| フレームワーク | Tauri v2 + Rust | 入力送信・常駐の軽さ |
| フロントエンド | React + TypeScript + Vite + Tailwind + shadcn/ui + lucide-react。色・モーション等は `apps/desktop/src/styles/tokens.css` のCSS変数 (実装で使う値だけを置く)。フォントはIBM Plex Sans JP / Mono を同梱 (オフラインで動くようGoogle Fontsは使わない) | |
| ダークモード | システム設定に追従。デザインの参考表示(gray 700〜900を面に使用)に従う | |
| 言語 | **表示言語** (`Settings.uiLanguage`、UI・メニューバー・表示用エラー) と **話す言語** (`Settings.speechLanguage`、ASR の `language`・推奨モデル・音声コマンドの既定) を分けて持つ。どちらも ja・en。詳細は「言語」の節。計画は [docs/plans/i18n-plan.md](plans/i18n-plan.md) | 2026-10-06 決定。macOS を英語にして日本語を話す人を両立させるため。`language` を省いた自動判定は ja-8bit の英語で WER 1.8%→28.3% と崩れる (spikes/asr-bench/MODEL_DECISION_I18N.md) ため常に明示する |
| 録音 | Rust (cpal) | WebView経由のgetUserMediaは権限ダイアログ二重表示等の既知問題あり |
| VAD | Silero VAD (`ort`、arm64は静的リンク)。差し替え可能なtraitの背後に置く | 代替: earshot |
| ASR | Python + MLX (`mlx-qwen3-asr`)。既定のモデルは `neosophie/Qwen3-ASR-1.7B-JA` を全層8bit量子化したもの (自前変換、`minimalcorp/Qwen3-ASR-1.7B-JA-MLX-8bit`、約2.2GB)。元の bf16 版 (`neosophie/Qwen3-ASR-1.7B-JA`、約4.1GB) は既に手元にある導入でのみ一覧に出る (下の「モデルの管理」)。どちらも revision (commit) を固定して取得 | Rust実装(candle/MLX)は約3倍遅い (spikes/asr-bench)。8bitはfp16と同等精度・約2割速い・メモリ1/3 (spikes/asr-bench/MODEL_DECISION.md) |
| モデルの管理 | 候補はアプリに固定 (`provisioning/models.rs` の `CATALOG`)。常に「取得済みのモデルが1つ選択されている」状態を保つ (取得途中は選べない、選択中は削除できない)。取得 (進捗・一時停止・再開・中止)・削除はモデルごと。**取得中にできるのは1つ** (一時停止・失敗で止まっているものは複数あってよい)。モデルの操作はセットアップ完了後のみ (セットアップの取得と同時に走らせない)。詳細は「モデルの管理」の節 | 2026-10-01 決定 |
| 操作 | 音声入力のON/OFFは **常時表示パネルのボタン**・**メニューバー**・**グローバルショートカット** (既定 ⌥Space、`Settings.shortcut` で変更・無効化可。`tauri-plugin-global-shortcut` = macOS は Carbon `RegisterEventHotKey` で追加の権限は不要)。押下で、OFF なら ON。ON なら入力モードで分岐: 常に聞き取る→OFF / 1回ずつ聞き取るで未発話→取り消して OFF / 発話中→無音を待たずに確定して OFF。押している間だけ録音するモードは実装しない | 2026-09-30 確定、2026-10-02 ショートカットを追加 (周囲に人がいる環境で入力のタイミングを自分で決める「1回ずつ聞き取る」の開始手段として) |
| 入力単位 | ONの間、発話(VAD区間)ごとに文字起こしし、話し終わったら入力。入力は単一キューで直列化 | 必須要件 |
| 入力モード | `Settings.inputMode`。`continuous` (常に聞き取る・既定): ONの間ずっと発話ごとに入力。`oneShot` (1回ずつ聞き取る): ONにしてから1発話を確定 (VAD の話し終わり・最大長、またはショートカットの再押下) したら自動で OFF。短すぎる発話 (誤検出) では OFF にしない。ON (または誤検出) から10秒 (固定) 話し始めなければ OFF。開始手段 (パネル・メニューバー・ショートカット) によらず同じ。セットアップの「入力モード」ステップと 設定 > 音声入力 で選ぶ | 2026-10-02 決定。ひとりなら常に聞き取る、周りに人がいる・会話が聞こえる場所では入力のタイミングを自分で決めたいため |
| リアルタイムプレビュー | 発話中は前回から音声が0.8秒以上伸び、かつ途中表示の要求が処理中でなければ、発話開始からの音声を文字起こしし直してパネルに表示する。入力するのは話し終わり時点の最終結果のみ。確定後は最終結果で表示を置き換えて750ms表示する (入力成功時は成功マークのみで入力先アプリ名は出さない)。推論時間の見積もり(実測から学習)が話し終わりの無音(silenceMs)を超える場合は送らない。長い発話は区切り (見積もりが silenceMs に収まる最長、3〜12秒) ごとに静かな所で確定し、以後は区切りの後の音声だけを送る (表示は確定した区切りの文字 + 今の区切りの文字。1回の推論が発話の長さに比例して伸びず、確定を遅らせない) | 2026-09-30 確定。値はtsunagiの音声入力に準拠 (implementation-plan.md「音声入力の体験」)。途中表示の応答待ちを取り消してもサーバーの推論は止まらず(直列実行)、確定がその分遅れるため |
| 入力方式 | クリップボード + ⌘V、元のクリップボードを復元 | IMEの影響を受けない |
| 自動送信 | `Settings.autoSubmit` (既定 OFF) が ON なら、貼り付けた発話の直後に送信キー (`Settings.autoSubmitKey`: Enter または 主修飾キー+Enter) を送る。入力モードによらない。何も入力しなかった発話 (empty・discarded・skipped_excluded・failed)、音声コマンドに一致した発話、正規化 (音声コマンドと同じ) すると空になる文字列 (句読点だけ等。貼り付けはする)、貼り付けの間に前面アプリが変わった発話 (送信キーが別のアプリに届くため。貼り付けはする) では送らない。設定 > 音声入力 で切り替える | 2026-10-08 決定。チャット等で話すたびに手で送信しなくて済むように。キーは Windows 対応を見越して OS 非依存の値 (`modEnter`) で持つ |
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
| `Contents/Resources/LICENSE`, `NOTICE` | 本体のライセンス (Apache-2.0) と著作権表示 (リポジトリ直下のもの。Apache-2.0 §4(a)(d) で再配布物に含める) |
| `Contents/Resources/THIRD_PARTY_NOTICES`, `licenses/` | 同梱する第三者のライセンス |

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
| `ja-8bit` | `minimalcorp/Qwen3-ASR-1.7B-JA-MLX-8bit@698eff963b084561b12a045c95bc4a208898337f` | 2,185,804,096 B (約2.2GB) | 日本語向けに追加学習 (`tunedFor: "ja"`)。英語も認識できる。話す言語 ja の推奨 |
| `base-1.7b-8bit` | `minimalcorp/Qwen3-ASR-1.7B-MLX-8bit@fc85f8e586506b91c707de9561998928f3f5d842` (元 `Qwen/Qwen3-ASR-1.7B@7278e1e70fe206f11671096ffdd38061171dd6e5` を全層8bit) | 2,174,372,462 B (約2.2GB) | 追加学習なしの元のモデル。話す言語 en の推奨 |
| `ja-bf16` | `neosophie/Qwen3-ASR-1.7B-JA@987bda160f2dabfa6757550bcff7cdda2ba0648c` | 4,092,092,275 B (約4.1GB) | 元の bf16 版。**旧候補** (どの話す言語の並びにも無いもの): 手元にある導入でのみ出す (下の「旧候補」) |

容量は固定した revision の tree API の値 (取得対象 `*.json *.safetensors *.txt *.model` の合計)。表示名・説明は表示言語ごとに持ち `list_models` で返す。

- **話す言語ごとの並び** (2026-10-06 決定。`provisioning/models.rs` の `model_order(Locale)`。言語の欠落がコンパイルで落ちるよう match で書く): ja = `ja-8bit` → `base-1.7b-8bit`、en = `base-1.7b-8bit` → `ja-8bit`。先頭が推奨 (`ModelInfo.recommended`)。`list_models` はこの順 (並びに無い旧候補は末尾) で返す。並びは言語ごとに明示し、規則から自動で決めない。候補は 1.7B の 8bit のみ (5bit・0.6B は計測したが出さない)

- **旧候補** (2026-10-02 決定): 新規に選べる候補は `model_order` に載るもの (`ja-8bit`・`base-1.7b-8bit`)。旧候補は、選択中か取得中か手元にファイル (そのモデルのディレクトリ。取得済み・途中・古い revision を含む) がある時だけ `list_models` に出し、それ以外 (`not_downloaded` かつ選択中でない) は出さない。出ていない旧候補への `download_model`・`select_model`・`delete_model`・`cancel_model_download` は「不明なモデルです」。既に使っている人はそのまま使い続けられ、削除すると一覧から消える (再取得はできない)。複数モデルの取得・選択・削除の仕組みは残す (今後候補を足すため)。一覧が1件の時は使用中の行に削除ボタンを出さない (切り替え先が無いため)

- **選択**: 選択中のモデルは `provisioned.json` の `selectedModel` に記録する (`Settings` には置かない。「取得済みのものだけ選べる」は導入の記録と一緒に保つ必要があり、「実行環境とモデルのみ削除」で記録ごと既定に戻るため)。`select_model` は取得済み (現在の revision の記録があり `config.json` がある) のモデルだけ受け付け、ASR サーバーを新しいモデルで起動し直す (音声入力は OFF になり phase は loading を経由)。準備完了 (`/health`) まで待ち、**準備完了してから選択を記録して** 返る (切り替えの途中でアプリが終わっても、読み込めるか分からないモデルを選択中に残さない。その間 `ModelInfo.selected` は元のモデルのまま)。切り替えの起動は自動再起動なしで行い、準備完了したら自動再起動を有効にする
- **切り替えの失敗**: 新しいモデルでサーバーが準備完了にならなければ (異常終了・読み込みの上限10分)、元のモデル (選択は元のまま) で起動し直し (自動再起動あり)、エラーで reject する (「『<新>』を読み込めませんでした。『<元>』に戻しました」)。新しいモデルの異常終了は `asr_stopped` にしない (元のモデルの読み込み中に停止エラーを出さないため)。準備完了後に選択を記録できなかった場合も元のモデルに戻して reject する。元のモデルでも起動できなければ通常の `asr_stopped`
- **切り替え中**: `select_model`・`delete_model`・`restart_asr`・`delete_runtime_and_model`・`uninstall` はエラー (「モデルを切り替え中です」。失敗時に元のモデルを起動し直す処理と重ねないため)。アップデートのインストール中 (再起動待ちを含む) も同じ操作と `download_model` はエラー (「アップデートをインストールしています」)
- **取得**: モデルごとに開始・一時停止・再開・中止。処理はセットアップの model と同じ (`hf.rs`。部分ファイルからの再開・検証・huggingface_hub 互換のレイアウト)。同時に取得するのは1つ (他が取得中なら `download_model` はエラー)。一時停止・失敗で止まったものは複数残ってよい。完了したら `models` に記録する (選択は変えない)。中止 (`cancel_model_download`) は途中のファイルごとそのモデルのディレクトリを消す (削除と同じく、開発ビルドが本番のバンドルIDで動いている時は拒む)
- **削除**: `delete_model` は選択中・取得中のモデルを拒む。記録を先に消してから `models/hub/models--<org>--<name>/` を消す (データディレクトリの目印を確かめる。開発ビルドが本番のバンドルIDで動いている時は拒む)。ディレクトリの削除中 (中止を含む) はそのモデルの取得・削除を拒む
- **利用できる時**: モデルの操作 (`select_model`・`download_model`・`delete_model` 等) はセットアップ完了後 (`ProvisioningStatus.stage` が `done`) のみ。それ以外・削除の実行中はエラー。セットアップの取得は `ProvisioningStatus` で表し、`list_models` には手元のファイルの状態だけが出る
- **移行** (起動時): `selectedModel` が無い・カタログに無い・そのモデルの記録 (どの revision でも) かディレクトリが無い場合は、既定 (話す言語の推奨) が記録ありならそれ、無ければ記録のある他のモデル (カタログ順)、どれも無ければ既定を選ぶ (ここでの既定 = 話す言語の推奨)。記録 (runtime・models・verify) があれば `selectedModel` を書き込む。つまり **bf16 だけ導入済みの既存の導入は bf16 を選択中として残し、8bit を自動では取得しない** (2GB 超の取得を利用者の操作なしに始めないため)。8bit への切り替えは設定画面から (取得 → 選択)
- **revision が変わった時** (アプリの更新): 選択中のモデルは起動時にセットアップの自動やり直しで取り直す (上記)。選択中でないモデルは記録が合わないため取得済みではなくなり、古いファイルが残っていれば `paused` と表示する (`download_model` で新しい revision を取る。同じファイルは取り直さない。完了時に古い版を消す)
- **ストレージ**: `StorageUsage.modelBytes` は `models/` 全体 (全モデル・取得途中を含む)。モデルごとの量は `ModelInfo.diskBytes`。「実行環境とモデルのみ削除」は取得中のモデルを止めてから全モデルを消し、選択を既定 (話す言語の推奨) に戻す (記録ごと消えるため)。アンインストールも取得を止めてから消す
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
- 場所の確認: 実行中の .app のパスに `/AppTranslocation/` を含む、または `/Volumes/` 配下 (dmg から直接起動) なら確認・取得をせず `unavailable` (理由「アプリケーションフォルダに移動すると自動でアップデートできます」)。書き込めない場所 (他の管理者が入れた等) は updater が管理者のパスワードを求める。Windows の対象・インストールの流れは「Windows 版」の「同梱物・配布 (Windows)」
- 確認の時期: セットアップ完了後、`Settings.autoCheckUpdates` が true なら起動30秒後と、前回の確認から6時間ごと (10分ごとに経過を見る。スリープ明けにも追いつく)。`check_for_update` (手動) は設定によらずいつでも。同時に1つだけ (確認・取得中の再要求は何もしない)
- 取得: 新しい版が見つかれば続けて取得する (約40MB。取得したものはメモリに保持し、アプリを終了すると捨てる。次の起動で取り直す)。署名の検証は取得時に updater が必ず行う。取得済み (`ready`) の後の確認で、取得済みより新しい版 (semver で比較) があれば取り直す。同じか古い版 (Latest の取り下げ等) なら取得済みを残す
- インストール (`install_update`): `ready` の時のみ。`ready` のまま裏で確認・取り直しをしている間はそれが終わるのを待ち、終わった時点で `ready` なら進める (そうでなければ「インストールできるアップデートがありません」)。`ready` でない確認・取得中はエラー (「アップデートを確認しています。しばらくしてからもう一度お試しください」)。セットアップ・モデルの取得・切り替え・削除・アンインストールの実行中はエラー (「ダウンロード・削除の実行中は更新できません」)。インストール中 (`installing`、置き換え後の再起動待ちを含む) は `start_provisioning` を無視し、`download_model`・`select_model`・`delete_model`・`restart_asr`・`delete_runtime_and_model`・`uninstall` をエラーにする (「アップデートをインストールしています」)。音声入力を OFF にしてから updater の install (.app を一時領域に退避して置き換える) → `AppHandle::request_restart` (`RunEvent::Exit` で ASR を止めてから起動し直す)。install に失敗したら `error` にして再起動しない
- 表示: `ready` の間、メニューバー (とパネルの右クリックメニュー) の「設定…」の上に「再起動してアップデート (v<X.Y.Z>)」を出す (`install_update` と同じ処理。失敗はメニューの通知と同じくログと設定の表示のみ)。設定 > このアプリについて に状態・「アップデートを確認」・「再起動してアップデート」・自動確認の切り替え (`autoCheckUpdates`) を置く。macOS の通知 (通知の許可) は使わない
- 更新後の起動: 同梱物の版が変わっていれば既存の仕組み (「セットアップ手順」の版の判定) が実行環境を入れ直す
- 失敗 (確認・取得・インストール) はログに出し `error` (表示用の文言は表示言語)。自動の確認での失敗はメニューバーに出さない (設定の「このアプリについて」にだけ出す)
- 既知の制約 (tauri-plugin-updater 2.13): インストールにロールバックはなく、最後の置き換えに失敗すると .app が残らないことがある (plugins-workspace#3505)。更新後の .app の権限が 0700 になり他のユーザーが起動できないことがある (#3506)

### 言語

- **表示言語** `Settings.uiLanguage`: `"system"` (既定) | `"ja"` | `"en"`。`system` は macOS の優先言語 (`NSLocale.preferredLanguages`) を先頭から見て最初に ja・en に当たるもの、無ければ en。解決は Rust で行い (`get_locale`・`locale-changed`)、フロントエンドは WebView の `navigator.language` を使わない (.app が宣言するローカライズに左右されるため)。変更は再起動なしで全ウィンドウ・メニューバー (パネルの右クリックメニューを含む) に反映する
- **話す言語** `Settings.speechLanguage`: `"ja"` | `"en"`。ASR の `language` (ja → `Japanese`、en → `English`) を常に明示して渡す。推奨モデル (「モデルの管理」の並び) と音声コマンドの既定を決める
- **既定**: 新規 (settings.json が無い) は speechLanguage = 解決した表示言語。既存の settings.json に speechLanguage が無ければ `"ja"` (それまで日本語だけだったため)。未知の値は既定として読む
- **セットアップ中の話す言語の変更**: provisioning が実行中でなく model が `pending` (取得をまだ始めていない。「実行環境とモデルのみ削除」の後も含む) の間は、speechLanguage の変更で選択中のモデルをその言語の推奨に変える (`models-changed` を送る。取得の開始と重なっても食い違わないよう同じロック内で判定)。それ以外は選択を変えない (取得済みのモデルを勝手に変えない・数GBの取得を勝手に始めない)。設定の「認識」が推奨モデルの取得・切り替えを案内する
- **音声コマンドの既定**: ja = 確定・エンター → Enter、改行 → ⇧Enter、送信 → ⌘Enter (従来どおり)。en = enter → Enter、new line・line break → ⇧Enter、send → ⌘Enter。speechLanguage を変えた時、`voiceCommands` が変更前の言語の既定と同じ (利用者が編集していない) なら新しい言語の既定に入れ替える。編集済みなら変えない
- **表示用の文言**: Rust が作る文言 (メニュー・`AppError.message`・各 `error`・reject の文言・モデルの表示名と説明) は Rust 側の辞書 (表示言語ごと。キーの欠落はコンパイルで落ちる) から作った時点の表示言語で作る。表示用エラー (`ProvisioningStatus`・`ModelInfo`・`UpdateStatus`・`ShortcutStatus` の error) は送る時点の表示言語で文字列にする。表示言語の変更時は `status-changed`・`models-changed`・`provisioning-progress`・`shortcut-status-changed`・`update-status-changed` を送り直し、メニューバー・アプリのメニュー (Tauri の既定メニューは使わず `app_menu.rs` で組む。AppKit が自動で足す項目は macOS の言語のまま)・ウィンドウのタイトルを作り直す。想定外の失敗 (ウィンドウの作成等) の reject は操作ごとの短い文言にし、詳細はログへ。セットアップの動作確認 (verify) は検証用の音声が日本語のため話す言語によらず `Japanese` で送る。ログは日本語のまま (開発者向け)
- **Info.plist**: `CFBundleLocalizations` (ja・en)・`CFBundleDevelopmentRegion` (en。ja・en 以外の言語の macOS で、Rust の表示言語の解決 (en) と権限ダイアログ・AppKit の項目の言語をそろえるため) を置き、`NSMicrophoneUsageDescription` は Info.plist 本体を英語にして `{ja,en}.lproj/InfoPlist.strings` で翻訳する。権限ダイアログ (TCC) の文言は macOS の言語で決まり、アプリの表示言語には連動しない
- 言語を足す時: 表示言語は フロントエンド・Rust の辞書と対応表、話す言語は `model_order`・音声コマンドの既定・ASR の言語名 (話せる人が検証できる言語に限る)

## Windows 版

対象は Windows 11 (x64)。**UX は Mac と同じ**で、OS ごとに変えるのは実現手段・OS の語・キー表記だけ (不変条件と分岐の全体は [plans/windows-plan.md](plans/windows-plan.md))。OS 依存の窓口は Rust の `src/platform/` に集め、フロントエンドは `AppInfo.platform` と辞書 (`PerOs`) で出し分ける。Mac のコードパスは変えない。

### OS ごとの実現手段

| 機能 | Mac | Windows |
|---|---|---|
| 入力 | クリップボード + ⌘V (CGEvent) | クリップボードの全形式を退避 → テキストを遅延レンダリングで置く (履歴・クラウド同期・監視アプリから外す形式 `ExcludeClipboardContentFromMonitorProcessing`・`CanIncludeInClipboardHistory`=0・`CanUploadToCloudClipboard`=0 を付ける) → `SendInput` で Ctrl+V → 貼り付け先が読みに来た (`WM_RENDERFORMAT`) のを確かめてから復元 (読みに来なければ 1 秒で戻す。Ctrl+V の前に他が読んだ時は固定の 200ms)。戻した内容にも同じ除外の形式を付ける (履歴に二重に残さない)。前面が自分より高い整合性レベル (管理者として実行) のアプリなら UIPI で届かず失敗も返らないため、送らずに `insert_failed` (文言「管理者として実行中のアプリには入力できません」) |
| 音声コマンドのキー | CGEvent | `SendInput` (VK)。`cmd` は Win キー、`option` は Alt。既定の送信 (音声コマンド「送信」・自動送信の modEnter) は Ctrl+Enter。表示 (`UtteranceResult.key`) は `Ctrl+Shift+Enter` の形 (修飾は Ctrl・Alt・Shift・Win の順、Backspace) |
| 前面アプリ・入力しないアプリ | bundleId | 実行ファイル名 (小文字)。設定のキー名 `excludedApps[].bundleId` は変えず、値に exe 名を入れる。表示名は `FileDescription`、無ければ exe 名。ストアアプリは枠 (ApplicationFrameHost.exe) の中の本体のプロセス。`list_running_apps` は可視・所有者なし・ツールウィンドウでない・cloaked でないトップレベルウィンドウを持つプロセス (自分を除く) |
| パネル | NSPanel (non-activating) | `focusable(false)`・最前面・タスクバー非表示 + `WS_EX_NOACTIVATE` / `WS_EX_TOOLWINDOW`。サブクラスで `WM_MOUSEACTIVATE`→`MA_NOACTIVATE`、`WM_WINDOWPOSCHANGING` に `SWP_NOACTIVATE`、`WM_STYLECHANGING` で上の拡張スタイルを保つ (tao が状態の変更ごとに拡張スタイルを書き直し、表示し直しに `SW_SHOW` を使うため)。位置の計算 (`geometry`) は Mac と同じで、ディスプレイごとに「作業領域 (タスクバーを除く)・左下原点・y 上向き・論理 px」に換算する。`panelPosition` の x,y はそのディスプレイの左下からの論理 px、`displayId` はモニターのデバイス名 (`\\.\DISPLAY1`)。右クリックメニューは前面化 (`SetForegroundWindow`) せずに `TrackPopupMenu` で出す (Tauri (muda) のポップアップは前面化してから出すため、入力先のフォーカスが移る。実測)。前面化しないメニューは外のクリックで閉じないため、開いている間だけ低レベルのマウス・キーボードのフックで外のクリック・Esc を見て閉じる (Esc は前面のアプリに渡さない) |
| メニュー | メニューバー (NSMenu) | タスクトレイ。状態・エラーは無効化したメニュー項目。アイコンはメニューバーと同じ画像 (`icons/tray/*@2x.png`) をタスクバーの明暗 (`SystemUsesLightTheme`、無ければ暗い) の色で塗り、エラーは右上に赤い点 (実行時に描く)。左右どちらのクリックも同じメニュー。メニューにキーの表示 (Ctrl+, 等) は付けない。アプリのメニューバー (`app_menu.rs`) は作らない (`set_menu` は全ウィンドウにメニューバーを付けるため) |
| 権限 | マイク・アクセシビリティ | マイクのみ。状態は CapabilityAccessManager の `ConsentStore\microphone` の `Value` (HKLM = 端末全体、HKCU = アプリ、HKCU `NonPackaged` = デスクトップ アプリ) のどれかが `Deny` なら denied、読めなければ not_determined、それ以外 (値なし = 既定を含む) は granted。許可ダイアログは無く、`request_microphone` は denied 以外を granted として返す (実際に録音できるかは cpal のエラー)。拒否なら `ms-settings:privacy-microphone`。アクセシビリティはない |
| ログイン時に起動 | `SMAppService` | HKCU `Software\Microsoft\Windows\CurrentVersion\Run` の値 `mukuchi` (開発ビルドは `mukuchi-dev`) に `"<exe のパス>"`。`Explorer\StartupApproved\Run` の同名の値の先頭バイトが奇数 (利用者がタスク マネージャー・設定でオフにした) なら「承認待ち」(RequiresApproval) として読み、登録では上書きせず `LoginItemNotApproved` (設定 > アプリ > スタートアップ の案内)。解除は両方の値を消す (アンインストーラーも同じ 2 つの値を消す)。登録・解除は利用者の操作の時だけ (Mac と同じ) |
| 既定のショートカット | Alt+Space | Alt+Space (Mac と同じ)。登録中は Alt+Space がウィンドウのシステムメニューに渡らない。キーの記録中 (登録を外している) は設定・セットアップのウィンドウで Space による `SC_KEYMENU` を捨ててシステムメニューを出さない。ショートカットを受けた時に Alt・Win が押されたままなら割り当てのないキー (0xE8) を挟み、Alt の単独押下 (メニューモード)・Win の単独押下 (スタートメニュー) に見えないようにする (`platform/windows/sysmenu.rs`)。PowerToys Run・ChatGPT デスクトップ等も既定で Alt+Space を使うため、競合したら登録に失敗し設定で変えてもらう (セットアップの完了画面でも案内)。Windows は他アプリと衝突すると登録 (`RegisterHotKey`) に失敗するため `ShortcutStatus.error` で表示できる (Mac との差)。表示は `Ctrl+Alt+Space` の形 (キーの名前を + でつなぐ。`Cmd` は `Win`) |
| 再度の起動 | Reopen + single-instance | single-instance のコールバックのみ (設定、未完了ならセットアップを開く) |
| 表示言語 (`uiLanguage` = system) | `NSLocale.preferredLanguages` | `GetUserPreferredUILanguages` (設定 > 時刻と言語 の表示言語の並び) |
| フォルダ・ごみ箱 | NSWorkspace | `ShellExecuteW` (エクスプローラー・`ms-settings:` も同じ) / `SHFileOperationW` (`FOF_ALLOWUNDO`、確認なし) |
| 子プロセス | env 最小限 | `CREATE_NO_WINDOW`、`SystemRoot` `TEMP` `TMP` `USERPROFILE` `LOCALAPPDATA` `PATH`(System32) だけ渡す。**Job Object (`KILL_ON_JOB_CLOSE`)** に入れ、アプリが落ちても残さない (Mac の stdin EOF 終了の代わり) |
| シンボリックリンク | HF のスナップショット | 使わない。スナップショットは blob のハードリンク (NTFS は権限なしで作れる。作れなければコピー)。使用量はハードリンクを実体ごとに1回だけ数える (ボリュームのシリアル番号 + ファイル ID) |

### ASR (Windows)

- Python・uv・MLX は使わず、**llama.cpp の `llama-server` (Vulkan 版、b11408 に固定、同梱)** を子プロセスで動かす。モデルは GGUF 2 ファイル (LLM Q8_0 + mmproj Q8_0)。Rust の `AsrBackend` の背後に置き、Mac の `MlxServer` と OS で選ぶ。パイプライン (VAD・プレビュー・コマンド判定・入力) は `AsrBackend` だけを見る
- 起動: `llama-server.exe -m <llm.gguf> --mmproj <mmproj.gguf> --device <VulkanN> -ngl 99 --port <空き> --host 127.0.0.1 -c 4096 --no-webui --no-slots -np 1` (`--device` は 1 つに固定。CPU 実行は `-ngl 0 --no-mmproj-offload` で CPU 版。`--no-slots`: llama-server は CORS で全オリジンを許すため /slots でプロンプトを読ませない。`-np 1`: 推論は直列のためスロットでコンテキストを分けない)。起動ごとに乱数の API キーを作り、環境変数 `LLAMA_API_KEY` で渡して (コマンドラインには置かない。ログにも出さない) 認識の要求に `Authorization: Bearer` を付ける (キーの無い要求は 401。`/health` はキー不要)。開発の `MUKUCHI_ASR_URL` の外部サーバーにはキーを付けない。準備完了は `GET /health` (読み込み中は 503。上限 10 分)。異常終了は 3 回まで自動再起動 (Mac と同じ `asr_process`)。停止は stdin の EOF が無いため即座に終了させる。出力は `asr-server.log` (5MB で `.1` に1世代。Mac と同じ。認識した文章は出ない: 既定の verbosity では prompt を記録しない)。同梱の Vulkan 版はインストール先から直接使い、CPU 版は同意後に `<データ>/llama-cpu/` に取得する (下の「GPU の判定と CPU 実行の同意」)
- 認識: `POST /v1/chat/completions`。system メッセージ = `Settings.asrContext`、user = `input_audio` (WAV base64)、`temperature=0`、assistant の prefill `language <Japanese|English><asr_text>` (`continue_final_message`。`language` は常に明示)。応答の `language X<asr_text>` の接頭辞を除く。直列実行 (キューで 1 つずつ)。`elapsed_ms` はクライアントで計測
- 暴走の防止: `max_tokens` を音声の長さから見積もって制限し (`24 + 15 × 秒`、上限 2048。日本語の速い発話 約10文字/秒でも届かない)、繰り返しを検出して捨てる (区切り・大文字小文字を除いて、40 文字以内の同じ語句が 4 回以上・合わせて 20 文字以上続いたら結果を空にする)。無音・雑音の入力で暴走しうる (WINDOWS_DECISION.md「ハルシネーション」。実機で元の Qwen + 無音 3 秒の暴走が空になることを確認)。`filters.py` (定型ハルシネーション除外) は Rust (`asr_filters.rs`) に移し、tests/test_filters.py と同じケースで同じ結果にする
- モデル (`CATALOG` は OS ごと): `ja-gguf` = `minimalcorp/Qwen3-ASR-1.7B-JA-GGUF@7017bd6ff5156a4e9ad32997d2a9e38eedcb370e` (neosophie JA。2,190,132,448 B)、`base-gguf` = `minimalcorp/Qwen3-ASR-1.7B-GGUF@bf5c671638392f5d963391fb56765771def5fdfe` (元の Qwen。2,520,744,384 B)。容量は tree API の取得対象 (`*.gguf`。LLM と `mmproj*` の 2 ファイル) の合計。取得済みの判定は LLM と mmproj の組がスナップショットに揃っていること (MLX の `config.json` の代わり)。`model_order`: ja = [ja-gguf, base-gguf]、en = [base-gguf, ja-gguf] (Mac と同じ形)。各候補が実行方式 (`mlx` / `gguf`) と動かせる環境 (OS・CPU) を持ち、**動かせない候補は `list_models` に出さず**、`select_model`・`download_model` も拒否する。Mac = mlx のみ、Windows = gguf のみ
- 根拠: spikes/asr-bench/WINDOWS_DECISION.md

### GPU の判定と CPU 実行の同意

- 判定は 2 段階: (a) DXGI でソフトウェアアダプターを除いたアダプターを数える (ダウンロード前に動く)、(b) 同梱の Vulkan 版 `llama-server --list-devices` で推論に使えるデバイスを確定 (正)。`ok` = 独立 GPU あり (複数なら独立 GPU を優先して固定)、`integrated` = 内蔵のみ (確認画面は出さず、動作確認 (verify) の実測遅延が閾値を超えたら通知)、`driver_missing` = (a) にハード GPU がいるのに (b) が空 (ドライバー更新の案内)、`none` = どちらも空
- **CPU 実行は利用者が同意した時だけ** (`Settings.cpuInferenceAccepted`)。`none`・`driver_missing` で、同意するまでモデルの取得も CPU 版 (取得) の使用も始めない。GPU が使えるようになれば自動で GPU に切り替える。起動時に GPU が使えず未同意なら `gpu_unavailable`。GPU がある PC には画面を 1 つも増やさない (判定はセットアップの Welcome の間に裏で行う)
- 実装 (`gpu.rs`): 判定は起動時 (ASR の起動前) と `probe_gpu`・セットアップの開始 (再試行を含む) のたびに行う。(a) は DXGI の `EnumAdapters1` (`DXGI_ADAPTER_FLAG_SOFTWARE`・VendorId 0x1414 を除く)、独立/内蔵は D3D12 の `UMA` (取れなければ専用 VRAM 512MB 未満を内蔵とみなす)。Vulkan のデバイスは名前が一致する DXGI のアダプターで独立/内蔵を決める (一致しなければ独立)。`--device` は独立 GPU のうち VRAM の大きいもの (同じなら列挙の順)
- `start_provisioning` は最初に同意を確かめ、未同意なら何も取得せず `stage: "error"` (error「GPU が見つかりません。CPU で続けるには…」) で止まる。同梱の llama-server が無い・起動できない時も同様 (「入れ直してください」)。同意後の再試行で runtime が CPU 版 (`llama-b11408-bin-win-cpu-x64.zip`、sha256 固定、GitHub Release) を取得し、Windows 標準の tar で展開して必要なファイルだけを `<データ>/llama-cpu/` に置く (印 `.mukuchi-llama-cpu` に zip の sha256)。`provisioned.json` の `runtime.version` は `llama.cpp-b11408+vulkan-<同梱 zip の sha256>`
- 同意・再検出で使う llama-server・デバイスが変わったら起動し直す (CPU 版が無ければ導入をやり直す)。同意を取り消して GPU も無ければ止めて `gpu_unavailable`
- `gpu_unavailable` の action: `driver_missing` は `probe_gpu`、`none` は `accept_cpu`。`accept_cpu` はその場で同意せず 設定 > 認識 を開く (メニュー・パネルとも。注意書きを読んでから同意させるため)
- セットアップの同意画面の「やめる」用に、Windows だけ setup ウィンドウに `core:window:allow-close` を許す (`capabilities/windows.json`、`platforms: ["windows"]`。Mac は変えない)
- LP では判定しない (ブラウザからは不確実)

### 識別子・パス (Windows)

| | 値 |
|---|---|
| バンドルID | `com.minimalcorp.mukuchi` / `.dev` (Mac と同じ) |
| データ | `%LOCALAPPDATA%\<バンドルID>\` (Tauri の `app_local_data_dir`。移動プロファイルに載せない)。配下の構成は Mac と同じ (`llama-server` は同梱をインストール先から使うためコピーしない。Python・venv・uv はない)。WebView2 のデータ (`EBWebView\`) も Tauri がここに置く |
| ログ | `app_log_dir` (`%LOCALAPPDATA%\<バンドルID>\logs`。データの中) |
| インストール先 | NSIS (`currentUser`) の既定は `%LOCALAPPDATA%\<productName>\` = `%LOCALAPPDATA%\mukuchi\` (Tauri 2.12 の installer.nsi の `$LOCALAPPDATA\${PRODUCTNAME}`。`Programs\` の下ではない)。`mukuchi.exe`・`uninstall.exe`・同梱物 (Resource は実行ファイルのフォルダ)。アンインストール情報は `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\mukuchi` (`UninstallString` = `"<インストール先>\uninstall.exe"`) |
| 削除の安全策 | 目印 `.mukuchi-data` などは Mac と同じ。パスの比較は大文字小文字を区別せず、`\\?\` を外し、実在する部分は canonicalize で 8.3 の短い名前を長い名前にする (`paths::comparable`)。`..` は `\\?\` 付きで `/` が区切りにならない場合も文字列で拒む。`MUKUCHI_DEV_DATA_DIR` はドライブ・共有の直下も拒む |

### 同梱物・配布 (Windows)

- インストーラー: NSIS (`currentUser`、管理者権限不要。インストール先は `%LOCALAPPDATA%\mukuchi` (tauri の既定 `$LOCALAPPDATA\<productName>`)、アンインストール情報は HKCU)。成果物名は `mukuchi_x64-setup.exe` で固定 (LP の最新版リンク `releases/latest/download/mukuchi_x64-setup.exe`)。言語は English・Japanese (OS の言語で選ぶ)。WebView2 は入っていれば何もしない (Windows 11 は標準で入っている。無い時だけブートストラッパーを取得: `downloadBootstrapper`)。**署名しない** (SignPath 不承認。SmartScreen の警告が出る。Smart App Control が有効な PC では起動できない)。作り方は `apps/desktop/scripts/build-windows.mjs` (`make build` (Windows)・release.yml の build-windows。docs/release.md の「Windows」)。フック (アンインストール) は `src-tauri/windows/installer-hooks.nsh`
- 同梱 (インストール先の構成。`tauri.windows.conf.json` が Windows のビルドだけ同梱物・アイコン (`icon.ico`)・`bundle.targets` (`nsis`)・NSIS の設定を差し替える):
  - 直下: `mukuchi.exe`、VC++ ランタイム `vcruntime140.dll`・`vcruntime140_1.dll`・`msvcp140.dll`・`msvcp140_1.dll` (mukuchi.exe が ort 由来で `msvcp140*.dll` を import する)、`verify.wav`、`LICENSE`・`NOTICE`・`THIRD_PARTY_NOTICES` (llama.cpp・nlohmann/json・LLVM OpenMP・VC++ ランタイムを含む)・`licenses/`
  - `llama-server/`: Vulkan 版の最小構成 (`apps/desktop/scripts/fetch-llama-server.mjs` が b11408 の zip を sha256 固定で取得して `src-tauri/bundle-resources/llama-server/` に展開) + VC++ ランタイム `vcruntime140.dll`・`vcruntime140_1.dll`・`msvcp140.dll`。計 27 ファイル、約 86MB
  - VC++ ランタイムは app-local (DLL は実行ファイルのフォルダから先に探されるため、使うフォルダごとに置く)。Microsoft の再頒布可能パッケージ 14.44.35112 から DLL ごとの sha256 で取り出す (`fetch-vc-runtime.mjs`)。PE の import がすべて同梱か Windows 標準に解決できることを `check-windows-dlls.mjs` で機械的に確かめる (クリーンな環境 (VM 等) での起動は未確認)。CPU 版 (`<データ>/llama-cpu/`) も同じ 3 つに依存するため、runtime の導入時に同梱の `llama-server/` から写す (同じ中身なら上書きしない。写し元が無い・写せない時はログのみで続行。揃っていなければ runtime を未導入とみなして写し直す)
- アップデート: tauri-plugin-updater (minisign。Authenticode ではない)。`latest.json` に `darwin-aarch64` と `windows-x86_64` (updater は `windows-x86_64-nsis`、無ければ `windows-x86_64` を探す)。両 OS のビルドが成功した時だけ Release を公開する。成果物はインストーラー (`mukuchi_x64-setup.exe` とその `.sig`)
  - 対象: NSIS で入れたもの (実行ファイルの隣に `uninstall.exe` がある) の本番ビルド。`target\release` から直接動かしたもの等は `unavailable` (「アプリの場所が分からない…」)。置き場所 (Mac の /Volumes・App Translocation) の判定はしない
  - `install_update`: 音声入力 OFF → updater の install。Windows の install は取得したインストーラーを一時フォルダに書き、`on_before_exit` のフック → `ShellExecuteW` でインストーラーを `/P /UPDATE /R /ARGS …` で起動 → `std::process::exit(0)` (**RunEvent::Exit を経ない**。tauri-plugin-updater 2.13 の updater.rs)。そのためフックで `Core::shutdown` (セットアップ・取得・ASR (llama-server) の停止。インストーラーが上書きする前に止める) と、プラグイン既定のフックの `cleanup_before_exit` を行う。Job Object でも終了時に子は終わるが、上書きとの順序を確実にするため。再起動はインストーラーが行う (`/R`)。フックの後にインストーラーを起動できなかった場合は `error` にして今の版のまま `request_restart` する
  - `installMode` は既定の `passive` (`/P`: 進捗だけ出して確認なし。インストーラーは起動中の mukuchi.exe を Restart Manager で終了させる) のまま (tauri.conf に書かない)
  - 更新後の起動: `provisioned.json` の `runtime.version` (`llama.cpp-<tag>+vulkan-<同梱 zip の sha256>`) が変わっていれば runtime をやり直し (同梱の確認・GPU 判定)、CPU 版は印 (`.mukuchi-llama-cpu` の sha256) が違えば取り直す
- アンインストール (アプリ内「完全にアンインストール」): 役割を分ける。アプリは実行中にデータの下の `EBWebView`・ログ・インストール先の llama-server を消せないため、**削除はすべてアプリの終了後にアンインストーラー (NSIS) が行う**
  - Rust (`uninstall`): (本番) 実行ファイルの隣に `uninstall.exe` が無ければ何もせずエラー (「アンインストーラーが見つからない…設定 > アプリ から」) → 音声入力 OFF・セットアップ停止・ASR 停止 → `uninstall.exe /P /MUKUCHI_PURGE` を `ShellExecuteW` で起動 (作業ディレクトリは一時フォルダ。起動できなければ止めたものを戻してエラー) → スタートアップの登録 (HKCU `Run` と `Explorer\StartupApproved\Run` の値 `mukuchi`) を解除 → 終了。ファイルは消さない。開発ビルドは `uninstall.exe` が無いため常に dry-run (対象と起動するコマンドをログに出すだけ。macOS の `defaults`・`tccutil` は呼ばない。終了しない)
  - NSIS (テンプレート + フック。担当は配布): テンプレートが `$INSTDIR` の本体・同梱物・`uninstall.exe`・ショートカット・`HKCU\...\Uninstall\mukuchi`・HKCU `Run` の値 `mukuchi` を消す (`/UPDATE` でない時)。「アプリのデータを削除する」(確認ページのチェック) が入っている時だけ `$APPDATA\<バンドルID>` と `$LOCALAPPDATA\<バンドルID>` (データ・モデル・ログ・EBWebView) を消すが、`/P` では確認ページが出ずチェックは入らない。そのためフックで: `NSIS_HOOK_PREUNINSTALL` で `/MUKUCHI_PURGE` があれば (`/UPDATE` でない時) `$DeleteAppDataCheckboxState` を 1 にしてテンプレートに消させる、`NSIS_HOOK_POSTUNINSTALL` で (`/UPDATE` でない時) HKCU `Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run` の値 `mukuchi` を消す。オプション名は GetOptions が前方一致のため `/P` `/UPDATE` `/NS` `/R` `/ARGS` で始まらないものにする。アプリ終了直後は WebView2 のプロセスが `EBWebView` を掴んでいることがあるため、消し残ったら少し待って再試行する
  - 設定 > アプリ からのアンインストール (`/MUKUCHI_PURGE` なし): データはチェックを入れた時だけ消える (Tauri の既定どおり)。StartupApproved の値はフックが消す
  - `get_uninstall_targets` (確認ダイアログ): インストール先 (NSIS で入れたもの)・データ (`%LOCALAPPDATA%\<バンドルID>`。モデル・ログ・EBWebView を含めて 1 つ。`MUKUCHI_DEV_DATA_DIR` の時は差し替え先と別に出す)・残っているスタートアップの登録 (`HKCU\<キー>\mukuchi`、bytes 0)
- 「実行環境とモデルのみ削除」は Mac と同じ (`llama-cpu\`・`models\`・`provisioned.json`。同梱の llama-server・設定・ログ・EBWebView は残す)
- `mukuchi.exe --print-resource-paths` (隠し・UI なし): 同梱物 (llama-server・verify.wav) とアンインストーラーの解決結果を表示して終了 (0=同梱物が揃っている 1=欠けている)。インストール後の配置の確認用

## インターフェース

変更する場合は先にここを更新し、関係するsubagentに周知する。

### ASRサーバー HTTP API (asr-server ↔ Rust)

- 待受: `127.0.0.1:<port>`。本番はRustが空きポートを選び `--port` で渡し、`--exit-on-stdin-eof` 付きで起動する。開発は `18765` 固定でprocess-composeが起動し、アプリは環境変数 `MUKUCHI_ASR_URL` があればそれに接続する(自分では起動しない)
- `GET /health` → `200 {"status":"ok","model":"<id>"}`。モデル読み込み完了まで応答しない
- `POST /transcribe` — body: 16kHz/mono/16bit PCMのWAV (`Content-Type: audio/wav`)。query: `language` (既定 `Japanese`。アプリは `Settings.speechLanguage` から `Japanese` | `English` を常に付ける)、`context` (認識のヒント = `Settings.asrContext` をそのまま。任意。Qwen3-ASR のシステムメッセージにそのまま入る) → `200 {"text":"...","elapsed_ms":123}`
  - `elapsed_ms`: サーバーがbodyを受信し終えてから応答するまでの時間 (WAVデコード + 推論待ち + 推論)。ネットワーク転送は含まない
  - エラー: 不正なWAV/形式違い → `400`、body が 5MiB (約120秒分+余裕) を超える → `413`
- 開発用 (デバッグビルドのみ): `MUKUCHI_DEV_AUDIO_FILE=<wav>` でマイクの代わりにWAVを実時間で流す (その後は無音)。`MUKUCHI_DEV_AUTO_LISTEN=1` でASR準備完了後に自動でONにする (セットアップ画面は開かない)。`MUKUCHI_ASR_URL` 使用中はセットアップ不要とみなし、起動時にセットアップを開かずpanelを表示する (トレイの「セットアップを開く…」からは開ける)。`MUKUCHI_DEV_SHOW_SETUP=1` でそれをやめ本番と同じ判定にする (セットアップ画面の確認用)。`MUKUCHI_DEV_TARGET_BUNDLE=<bundle id>` でそのアプリが前面の時だけ入力する (自動テストで他のアプリに入力しないため)。`MUKUCHI_DEV_NO_PARTIAL=1` で途中表示を送らない (遅延の比較用)。`MUKUCHI_ASR_URL` もデバッグビルドのみ有効で、ループバックの http のみ受け付ける。`MUKUCHI_DEV_DATA_DIR=<dir>` でデータディレクトリを差し替える (本物のデータ・モデルに触れずに検証するため。受け付ける条件は「識別子・パス」の削除の安全策)。`MUKUCHI_DEV_UV` `MUKUCHI_DEV_ASR_SERVER_DIR` `MUKUCHI_DEV_VERIFY_WAV` で同梱物 (uv・asr-server/・verify.wav) を個別に差し替える。`MUKUCHI_DEV_UNINSTALL_DRY_RUN=1` でアンインストールは何も消さず対象と操作をログに出すだけ (アプリも終了しない。Windows の開発ビルドは指定がなくても常にこの動作)。Windows: `MUKUCHI_DEV_FORCE_GPU=none|integrated|driver_missing|ok` で GPU の判定結果を差し替える (同意の流れの確認用)、`MUKUCHI_DEV_LLAMA_SERVER_DIR` で同梱の llama-server/ を差し替える、`VK_DRIVER_FILES`・`VK_ICD_FILENAMES` を llama-server に引き継ぐ (存在しないファイルを指すと Vulkan が空になり、実機の経路のまま driver_missing を確かめられる)。`MUKUCHI_ASR_URL` は Windows では llama-server (`/v1/chat/completions`) とみなす
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
      | "vad_failed"    // 発話検出 (VAD) を初期化できない。表示「発話検出を開始できません」、action は null
      | "gpu_unavailable";  // Windows のみ: GPU が使えず CPU 実行への同意 (Settings.cpuInferenceAccepted) もない。action は accept_cpu / probe_gpu。「Windows 版」の「GPU の判定と CPU 実行の同意」
  message: string;   // 表示用 (表示言語)
  // 復旧操作。メニュー・パネルのボタンに対応
  action: "open_accessibility" | "open_microphone" | "select_microphone"
        | "restart_asr" | "start_setup"
        | "accept_cpu" | "probe_gpu"   // Windows のみ (gpu_unavailable)
        | null;
};

type Utterance = {
  id: number;
  text: string;
  stableLength: number;  // 前回の途中表示との共通接頭辞の長さ (UTF-16 コード単位 = JS の length/slice と同じ)。プレビューの表示には使わない (フロントエンドが前回の text と単語単位で差分を取る)
};

type UtteranceResult =
  | { kind: "inserted"; id: number; text: string; appName: string; submitted: boolean } // submitted: 自動送信の送信キーを送った
  | { kind: "command"; id: number; text: string; key: string }        // key 表示用 例 "Enter" "⇧+Enter" "⌘+Enter" (修飾は ⌃⌥⇧⌘ の順)。Windows は "Shift+Enter" "Ctrl+Enter" (Ctrl・Alt・Shift・Win の順)
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
  voiceCommands: { id: string; phrases: string[]; key: KeyCombo }[]; // 既定は話す言語ごと (「言語」)。言い方のないコマンド・正規化(NFKC・記号空白除去・小文字化)後に空/重複する言い方は update_settings がエラーにする
  asrContext: string;                     // 既定 ""。認識のヒント (自由記述)。前後の空白を除いて ASR の context にそのまま渡す (空なら渡さない)。最大 1000 文字 (Unicode スカラー値で数える。超えたら update_settings は保存せずエラー。context は URL のクエリで送り、uvicorn (h11) のリクエスト行+ヘッダーの上限 16KiB に日本語の URL エンコード (1文字9バイト) で収めるため。長いほど毎回の推論も遅くなる)。旧形式の vocabulary: string[] だけがある設定は、読み込み時に空白区切りでつないで asrContext に移す (それまでと同じ context になる)
  excludedApps: { bundleId: string; name: string }[];
  panelPosition: { x: number; y: number; displayId: string; version: 2 } | null; // null=既定位置。Rust (ドラッグ) だけが書く (フロントエンドは null にするだけ)。x,y はピル (影の余白を除いた描画内容) のアンカー点の、ディスプレイ左下からの位置 (整数pt、y上向き)。アンカー点はアンカー (panel-anchor) に当たるピルの辺・角 (例: 右上なら右上の角、中央下なら下辺の中央) で、アンカーはこの点の visibleFrame 内の位置 (左右3等分・上下2等分) から決まる。displayId は CGDirectDisplayID (ピルの中心があるディスプレイ)。Windows は x,y が作業領域を含むディスプレイの左下からの論理 px、displayId がデバイス名 (「Windows 版」)。version なし (旧形式: ウィンドウの下端中央) は起動時に Rust が見た目の位置を変えずに移行して保存し直す。大きさの変更で画面に収めるための自動のずれは保存しない
  setupCompleted: boolean;
  panelStyle: "full" | "compact";         // 既定 "full"。compact はマイクの円形ボタンのみ (プレビュー・文言なし)
  inputMode: "continuous" | "oneShot";    // 既定 "continuous" (「決定事項」の入力モード)。未知の値は既定として読む
  autoCheckUpdates: boolean;              // 既定 true。自動でアップデートを確認・取得する (「アップデート」)。false でも手動の確認はできる
  uiLanguage: "system" | Locale;          // 既定 "system"。表示言語 (「言語」)
  speechLanguage: Locale;                 // 話す言語。ASR の language・推奨モデル・音声コマンドの既定を決める (「言語」。既定は新規なら解決した表示言語、既存の設定に無ければ "ja")
  autoSubmit: boolean;                    // 既定 false。貼り付けた発話の直後に送信キーを送る (「決定事項」の自動送信)。送信キーだけ失敗したら failed (insert_failed)
  autoSubmitKey: "enter" | "modEnter";    // 既定 "enter"。modEnter は主修飾キー+Enter (macOS は ⌘+Enter。Windows では Ctrl+Enter を想定)。未知の値は既定として読む
  cpuInferenceAccepted: boolean;          // 既定 false。Windows のみ: GPU が使えない PC で CPU 実行に利用者が同意した (「Windows 版」)。Mac では使わない。
  shortcut: string | null;                // 既定 "Alt+Space" (Mac・Windows とも)。null=無効。形式は「修飾+…+キー」: 修飾は Ctrl・Alt・Shift・Cmd をこの順で1つ以上、キーは KeyboardEvent.code (例 "Space" "KeyM" "Digit1" "F5")。登録できなければ (形式の誤り・OS が拒否) update_settings は保存せずエラー。他アプリが同じキーを使っていても登録は成功しうる (global-hotkey 0.8 は非排他で `RegisterEventHotKey` するため衝突を検出できない。どちらに届くかは未確認)。Windows は `RegisterHotKey` が衝突で失敗する (起動時なら ShortcutStatus.error)
};
type Locale = "ja" | "en";
type ShortcutStatus = { shortcut: string | null; registered: boolean; error: string | null }; // error: 起動時などに登録できなかった時の表示用 (表示言語)
type KeyCombo = { key: "enter" | "tab" | "escape" | "backspace"; modifiers: ("cmd" | "shift" | "option" | "ctrl")[] };

type Permissions = {
  microphone: "granted" | "denied" | "not_determined";
  accessibility: boolean;   // Windows にアクセシビリティの権限はないため常に true (UI にも出さない)
};

type ProvisioningStatus = {
  stage: "idle" | "runtime" | "model" | "verify" | "done" | "paused" | "error";
  // 常に runtime, model, verify の順の3件。paused・error の時、止まった項目は "active" のまま
  // bytesTotal: model はファイル一覧の取得後に決まる (再開時は取得済みの分が bytesDone に入る)。runtime・verify は大きさが分からないため常に null
  items: { id: "runtime" | "model" | "verify"; state: "pending" | "active" | "done"; bytesDone: number; bytesTotal: number | null }[];
  bytesDone: number;          // 全体 = bytesTotal の分かる項目 (model) の合計
  bytesTotal: number | null;
  etaSeconds: number | null;  // model の取得中のみ (直近10秒の速度から。最初の2秒は null)
  error: string | null;       // stage=error の時の表示用 (表示言語)
};

type StorageUsage = { runtimeBytes: number; modelBytes: number; otherBytes: number }; // modelBytes は models/ 全体 (全モデル・取得途中を含む)

type ModelState = "not_downloaded" | "downloading" | "paused" | "error" | "downloaded";
type ModelInfo = {
  id: string;               // カタログの id (Mac: "ja-8bit" | "base-1.7b-8bit" | "ja-bf16"、Windows: "ja-gguf" | "base-gguf")。list_models は話す言語の並び (model_order。旧候補は末尾) の順で、表示もこの順。旧候補 (ja-bf16) は手元にある時だけ出る
  name: string;             // 表示名 (表示言語)
  description: string;      // 説明 (1文程度、表示言語)
  tunedFor: Locale | null;  // 追加学習で特化した言語 (ja-8bit・ja-bf16 は "ja"、元のモデルは null)。話す言語と違う時に「日本語向けに調整」等を添える
  sizeBytes: number;        // 取得するファイルの合計 (固定した revision の値)。進捗の分母・「約 2.2 GB」の表示に使う
  recommended: boolean;     // 話す言語の推奨 (model_order の先頭。新規のセットアップで取得するもの)。ちょうど1つ
  selected: boolean;        // 使用中。常にちょうど1つ (選択中は downloaded。ただしセットアップ未完了の間は未取得のことがある)
  state: ModelState;
  // downloading・paused・error: 取得済みのバイト数 (起動し直した後の paused は手元のファイルからの目安)。
  // downloaded: sizeBytes。not_downloaded: 0
  bytesDone: number;
  etaSeconds: number | null; // downloading のみ (直近10秒の速度から。最初の2秒は null)
  error: string | null;      // state=error の時の表示用 (表示言語)。再試行は download_model
  diskBytes: number;         // このモデルのディスク上の使用量 (取得途中・古い版を含む)
};
type AudioDevice = { id: string; name: string; isDefault: boolean };
type AppInfo = { version: string; build: string; platform: "macos" | "windows" };  // platform: ビルドした OS。フロントエンドの OS ごとの文言・キー表記の切り替えに使う

// Windows のみ。ASR を動かす GPU の判定結果 (「Windows 版」の「GPU の判定と CPU 実行の同意」)。Mac では get_gpu_status は kind "ok"・device "gpu" を返す
type GpuStatus = {
  kind: "ok" | "integrated" | "driver_missing" | "none";
  devices: { name: string; vramMb: number | null; integrated: boolean }[];  // Vulkan で推論に使えるもの。driver_missing・none は空
  selected: string | null;      // 使うデバイスの名前 (ok・integrated)
  device: "gpu" | "cpu";        // 実際に使う実行先。cpu は kind が none・driver_missing で Settings.cpuInferenceAccepted の時だけ
};
type UpdateStatus = {
  // unavailable: 開発ビルド・dmg から起動・App Translocation (「アップデート」)。idle: 未確認か最新
  state: "unavailable" | "idle" | "checking" | "downloading" | "ready" | "installing" | "error";
  currentVersion: string;
  latestVersion: string | null;   // 見つかった新しい版 (downloading・ready・installing、取得・インストールの失敗時)。最新なら null
  notes: string | null;           // latest.json の notes (無ければ null)
  bytesDone: number;              // downloading のみ意味がある
  bytesTotal: number | null;      // 大きさが分からなければ null
  checkedAt: number | null;       // 最後に確認が成功した時刻 (UNIX 秒。このプロセスでの値。永続化しない)
  error: string | null;           // error・unavailable の時の表示用 (表示言語)
};
type SettingsCategory = "general" | "voice" | "commands" | "recognition" | "permissions" | "storage" | "about";
```

#### commands

エラー時は表示用メッセージ (表示言語の文字列) で reject する。

| command | 引数 → 戻り値 | 用途 |
|---|---|---|
| `get_status` | → `AppStatus` | 初期表示 |
| `set_listening` | `{ on: boolean }` → `()` | パネル・メニューのON/OFF (oneShot でも同じ。ONにすると1発話で OFF に戻る) |
| `get_shortcut_status` | → `ShortcutStatus` | ショートカットの登録状態 (設定・セットアップでの警告表示) |
| `set_shortcut_suspended` | `{ suspended: boolean }` → `()` | ショートカットの記録中に登録を一時解除する (記録中に押したキーで ON/OFF しないため)。記録の終了・取り消し・ウィンドウを閉じた時に false で戻す |
| `get_locale` | → `Locale` | 解決した表示言語 (`uiLanguage` が system なら macOS の優先言語から。「言語」)。各ウィンドウの読み込み時に呼ぶ |
| `get_settings` / `update_settings` | → `Settings` / `{ patch: Partial<Settings> }` → `Settings` | 設定の読み書き(即時保存・即時反映。感度・無音時間は録音中も約0.5秒以内に反映、マイクの変更は録音をやり直す) |
| `list_input_devices` | → `AudioDevice[]` | マイク選択 |
| `get_permissions` | → `Permissions` | 権限表示(setupでは1秒ごとに再取得) |
| `request_microphone` | → `Permissions` | マイク許可ダイアログを出す |
| `get_gpu_status` / `probe_gpu` | → `GpuStatus` / → `GpuStatus` | Windows のみ (Mac は常に ok)。判定結果の取得 / 再検出 (設定 > 認識・セットアップ・`gpu_unavailable` の復旧) |
| `open_system_settings` | `{ pane: "microphone" \| "accessibility" \| "login_items" }` → `()` | システム設定 (Windows は「設定」アプリ: microphone → `ms-settings:privacy-microphone`、login_items → `ms-settings:startupapps`、accessibility は使わない) を開く。`login_items` はログイン項目 (`SMAppService.openSystemSettingsLoginItems`。launchAtLogin を ON にできなかった時の案内用) |
| `restart_asr` | → `()` | エラーからの復旧 (選択中のモデルで起動し直す。モデルの切り替え中はエラー) |
| `get_provisioning_status` | → `ProvisioningStatus` | |
| `start_provisioning` / `pause_provisioning` | → `()` | ダウンロード開始・再開・失敗後の再試行 (実行中・完了済み・削除やアップデートのインストールの実行中なら何もしない) / 一時停止 (止まるまで待って返る) |
| `get_storage_usage` | → `StorageUsage` | runtime = python・venv・uv・cache・asr-server、model = models (全モデル)、other = settings.json・provisioned.json・ログ (ディスク上の使用量) |
| `delete_runtime_and_model` | → `()` | 実行環境とモデルのみ削除 (セットアップ一時停止・モデルの取得の停止・ASR停止の後。全モデルを消す。設定・ログは残す)。以後 provisioning は idle、status は `runtime_missing`、モデルの選択は既定 (`models-changed` を送る) |
| `list_models` | → `ModelInfo[]` | モデルの一覧 (話す言語の並び。旧候補は手元にある時だけ末尾に。「モデルの管理」) |
| `select_model` | `{ id: string }` → `()` | 使うモデルを切り替える (取得済みのみ)。ASR を新しいモデルで起動し直し、準備完了まで待って選択を記録してから返る。失敗したら元のモデルに戻してエラー (「モデルの管理」)。選んだモデルが既に選択中なら何もしない |
| `download_model` | `{ id: string }` → `()` | 取得の開始・一時停止からの再開・失敗後の再試行。開始したらすぐ返る (進捗は `models-changed`)。取得済み・取得中なら何もしない。他のモデルが取得中ならエラー |
| `pause_model_download` | `{ id: string }` → `()` | 一時停止 (止まるまで待って返る)。途中のファイルは残す。取得中でなければ何もしない |
| `cancel_model_download` | `{ id: string }` → `()` | 中止。取得中なら止めてから、途中のファイルを消して `not_downloaded` にする。取得済みならエラー (削除は `delete_model`)。開発ビルドが本番のバンドルIDで動いている時はエラー |
| `delete_model` | `{ id: string }` → `()` | 取得済み (または paused・error) のモデルを消して `not_downloaded` にする。選択中・取得中はエラー |
| `get_uninstall_targets` | → `{ path: string; bytes: number }[]` | 確認ダイアログの一覧 (存在するものだけ。bytes はディスク上の使用量)。Windows はスタートアップの登録 (`HKCU\…\Run\mukuchi` の形、bytes 0) も含む |
| `uninstall` | → `()` | 完全にアンインストール(完了後にアプリ終了)。Windows はアンインストーラーを起動して終了する (削除はその後にアンインストーラーが行う。「Windows 版」) |
| `list_running_apps` | → `{ bundleId: string; name: string }[]` | 入力しないアプリの追加候補 |
| `open_logs_folder` | → `()` | Finder (Windows はエクスプローラー) で開く |
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
| `show_panel_menu` | `{ x: number; y: number }` → `()` | panelの右クリック。メニューバーとほぼ同じ内容のmacOS標準メニュー (違い: 音声入力のオン・オフは出さず (パネルのボタンで切り替えるため)、代わりにチェック項目「コンパクト表示」(`Settings.panelStyle` を切り替える) を出す) を、panelウィンドウ内の座標 (論理px、左上原点。MouseEvent の clientX/clientY をそのまま渡す) に表示する (Windows は前面化しないネイティブのポップアップメニュー。「Windows 版」) (メニューバーのアイコンがノッチで隠れても操作できるようにするため)。メニューが閉じるのを待たずに戻る。項目の選択はメニューバーと同じ処理になる |

#### events (Rust → 全ウィンドウ)

| event | payload | 頻度・備考 |
|---|---|---|
| `status-changed` | `AppStatus` | 状態遷移時 |
| `audio-level` | `{ level: number; threshold: number; speech: boolean }` (0..1) | ON中のみ、約15Hz (VADフレーム2つごと)。levelはRMSを表示用に正規化、thresholdは感度から求めたしきい値の位置 |
| `utterance-started` | `{ id: number }` | 発話検出。前の発話の確定処理中に次の発話が始まることがある(idで区別) |
| `utterance-partial` | `Utterance` | リアルタイムプレビュー |
| `utterance-result` | `UtteranceResult` | 最終結果と入力結果 |
| `settings-changed` | `Settings` | 他ウィンドウからの変更の反映 |
| `locale-changed` | `Locale` | 解決した表示言語が変わった時 (`uiLanguage` の変更。system の時の macOS の言語の変更は起動時にだけ反映する) |
| `settings-navigate` | `{ category: SettingsCategory }` | settingsウィンドウ宛。表示中のカテゴリを切り替える |
| `panel-anchor` | `{ horizontal: "left" \| "center" \| "right"; vertical: "top" \| "bottom" }` | panel宛。大きさが変わる時にウィンドウのどの辺・角を固定して広げるか。フロントエンドは描画内容をこの基準に寄せて配置する (例: top なら上端から下へ広がる、right なら右端から左へ)。ピルの中心が visibleFrame の左1/3なら left・右1/3なら right・他は center、上半分なら top・他は bottom。変わった時 (ドラッグ中を含む) と panel 作成直後に送る。変わる時は新しいフレームを設定する前に送る。読み込み直後は `get_panel_anchor` で取る |
| `permissions-changed` | `Permissions` | 権限の変化を検知した時 |
| `shortcut-status-changed` | `ShortcutStatus` | ショートカットの登録状態が変わった時 (起動時の登録・変更・一時解除からの復帰) |
| `input-devices-changed` | `AudioDevice[]` | マイクの接続・取り外し・既定の変更を検知した時 (2秒ごとのポーリング。settings/setup を開いている間か ON の間のみ) |
| `provisioning-progress` | `ProvisioningStatus` | 実行中は変化があれば約4Hz。段階の変化 (開始・完了・一時停止・失敗) は即時 |
| `update-status-changed` | `UpdateStatus` | 状態が変わった時は即時。取得中は約4Hz |
| `gpu-status-changed` | `GpuStatus` | Windows のみ。判定結果が変わった時 (起動時・再検出・同意) |
| `models-changed` | `ModelInfo[]` | モデルの状態・選択が変わった時は即時 (取得の開始・完了・一時停止・失敗・中止・削除・選択、セットアップの完了、実行環境とモデルのみ削除、話す言語・表示言語の変更)。取得中は変化があれば約4Hz |
