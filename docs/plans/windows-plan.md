# Windows 対応 計画

作成 2026-10-05。ブランチ `feat/windows`。ASR の検証結果は [spikes/asr-bench/WINDOWS_DECISION.md](../../spikes/asr-bench/WINDOWS_DECISION.md)。設計の正は [architecture.md](../architecture.md) で、実装に入る前に「インターフェース」を先に更新する。多言語 (表示言語・話す言語の ja/en) は [i18n-plan.md](i18n-plan.md) が前提で、Windows もそれに従う (2026-10-08、`origin/main` の i18n 導入後に改訂)。

## 進捗 (2026-10-09)

| P | 状態 | 備考 |
|---|---|---|
| 0 | 済み | ASR・話す言語ごとのモデル・GPU 判定・CPU の扱い (WINDOWS_DECISION.md)。GGUF 2 リポジトリを HF に公開済み (`minimalcorp/Qwen3-ASR-1.7B-JA-GGUF`・`…-1.7B-GGUF`) |
| 0.5 | 済み | Windows に Rust・VS Build Tools・Node・pnpm を導入。`C:\mukuchi-dev\mukuchi` が Windows 側の clone。`apps/desktop/scripts/dev-windows.ps1` で起動 |
| 0.6 | 済み | Windows ネイティブでも `make` が同じコマンド名で動く (`Makefile.windows`・`process-compose.windows.yaml`。make 4.4.1・process-compose 1.122.0 は `install-dev-tools-windows.ps1`)。実機で setup (GGUF の取得・再開・検証)・up/up-desktop/up-web/ps/logs/down/restart・reset・cargo test・build の失敗を確認。**Windows の clone は Git for Windows の `core.autocrlf=true` で CRLF になり、web の prettier と `scripts/sign-updater.test.mjs` (fixture) が落ちる** (`.gitattributes` 未対応) |
| 1 | 済み (Mac は CI 待ち) | `cargo check/clippy/test/fmt` が Windows で通る。Mac は未コンパイル |
| 2a | 済み (メモ帳のみ) | U8 (フォーカスを奪わない)・U7 (IME での貼り付け・クリップボードの復元) が ○。VS Code・Chrome・Word・Teams/Slack は未確認。`Ctrl+Alt+Space` は Claude デスクトップの既定のクイック入力のショートカットと衝突した (この PC で登録に失敗) ため、既定は Mac と同じ `Alt+Space` に決定 |
| 2b | 済み (実機の通しは一部) | 入力・キー・前面アプリ・パネル・トレイ・自動起動・権限・shell・2 つ目の起動 |
| 3 | 済み | llama-server・認識・GPU 判定・CPU 同意・モデルのカタログ・セットアップ。`MUKUCHI_DEV_AUDIO_FILE` で WAV を流し、**メモ帳に「今日の午後3時から定例ミーティングがあります。」が入る通しを確認** |
| 5 | 済み | PerOs・GPU 同意画面・Windows のシナリオ (ja/en)。webkit のテスト・スクリーンショットは Mac の表示と差分なし |
| 4 | 未 | NSIS・アップデート・アンインストール・リリース (VC++ ランタイムの扱いを含む) |
| 6 | 未 | LP (ja/en) |
| 7 | 未 | 実機の通しとリリース |

既知の課題: セットアップ・設定ウィンドウでタイトルが 2 重に見える (Windows 標準のタイトルバー + アプリ内のヘッダー)。内蔵 GPU で遅い時の通知 (`GpuStatus.verifyMs`) は未実装。`llama-server` に `--no-slots` を付ける案 (CORS が全オリジン許可のため) は未対応。

## 1. 目的と原則

Windows 11 (x64) で mukuchi を使えるようにする。**維持するのは UX**。ショートカットで ON/OFF し、発話ごとに文字起こしして、フォーカス中のアプリへ入力するという体験は Mac と同じにする。OS ごとに変えてよいのは、実現の手段 (コマンド・API・文言・見た目の作法) だけ。

1. **UX 不変条件** (§3) は両 OS で同じ。変える場合は先に §3 を更新して合意を取る
2. **Mac の挙動は変えない**。Windows の実装は `cfg(target_os)` と `platform` で分け、Mac のコードパスは差分なしで動く (Mac の `make lint`・`make test`・Playwright のスクリーンショットが今と同じ)
3. 分岐は **1 か所に集める** (Rust は `src/platform/`、フロントは `lib/platform.ts` の文言・フラグ)。呼び出し側に `if mac / if windows` を散らさない
4. 推測で実装しない。OS の挙動 (IME・クリップボード・SmartScreen・NSIS の削除等) は公式ドキュメントと実機で確認し、確認できないものは「未検証」と書く

## 2. 決定事項

| 項目 | 決定 | 根拠 |
|---|---|---|
| 対象 | Windows 11 x64 のみ。ARM64・Windows 10 は対象外 | 2026-10-05 |
| ASR | **llama.cpp (`llama-server`) + GGUF (LLM Q8_0 + mmproj Q8_0)**。Windows では Python・uv・MLX を使わない。Mac は MLX のまま | WINDOWS_DECISION.md。本機で精度・遅延が基準内、`context` が効く。mmproj は Q8_0 で BF16 と同等 |
| 話す言語ごとのモデル | Mac と**同じ基準**: 特化モデルがあればそれ、なければ元のモデル、精度が同程度なら元のモデル。**ja = `neosophie/Qwen3-ASR-1.7B-JA` (GGUF)、en = `Qwen/Qwen3-ASR-1.7B` (GGUF、元のモデル)**。並び: ja = [ja, base]、en = [base, ja] | 実機検証 (WINDOWS_DECISION.md「話す言語ごとのモデル」): ja は ja モデルが CER 8.4% vs 11.6% (元の Qwen は数字を漢数字で書く)。en は LibriSpeech で 44 / 46 / 43 語の誤りでノイズの範囲 → 方針どおり元のモデル |
| モデルの取得 | ja 約 2.19GB (Mac と同じ)、en 約 2.52GB。リポジトリは自前変換して `minimalcorp/` に置く案を第一候補 (Mac と同じ運用)。公式 `ggml-org/Qwen3-ASR-1.7B-GGUF` を revision 固定で使っても精度は同等 (変換物の差は 64 バイト) | **要確認** (§2 末尾) |
| 標準の推論経路 | **Vulkan 版**を同梱 (全 GPU ベンダー対応)。CUDA 版は初回のスコープ外 (Vulkan で中央値 119ms、p90 269ms で足りる) | 同上 |
| CPU 実行 | **対応するが、利用者が明示的に同意した場合のみ** (§5)。LP では「GPU 推奨、CPU のみは非推奨」と書く | 主流ミドル CPU で中央値約 1.0〜1.8s (同上) |
| 署名 | **署名なし**。GitHub Releases から配布し、LP の最新版リンクで案内する | SignPath 不承認 (2026-10)。記憶: windows-unsigned-distribution |
| インストーラー | NSIS (`currentUser`、管理者権限不要)。成果物名は固定の `mukuchi_x64-setup.exe` | LP から固定リンクにするため |
| 自動アップデート | tauri-plugin-updater + minisign (Authenticode とは独立)。`latest.json` に `darwin-aarch64` と `windows-x86_64` を載せる | 署名なしでも成立 |
| 版 | Mac と共通 (`desktop-v<X.Y.Z>` の 1 つの Release に両 OS の成果物)。**両 OS のビルドが成功した時だけ公開** | 片方だけ新しい版になるのを避ける |
| データ | `%LOCALAPPDATA%\com.minimalcorp.mukuchi\` (Tauri の `app_local_data_dir`)。ログは `app_log_dir`。移動プロファイルに載せない | 数 GB のモデルを置くため |
| 設定 JSON | フィールド名は変えない (移行を避ける)。新規フィールドは §7 | |
| 開発 | Windows 実機は nix を使わない。Rust は rustup + MSVC、JS は pnpm、Mac の `make` 体系はそのまま | |
| モデルの実行環境 | カタログの各候補が**実行方式 (`mlx`/`gguf`) と動かせる環境 (OS・CPU)** を持つ。**動かせない候補は一覧に出さず**、`select_model`・`download_model` も拒否する。判定は Rust (フロントは受け取るだけ)。このタスクでは **Mac = mlx のみ、Windows = gguf のみ** (拡張できる形にするだけで、他の組み合わせは作らない) | 2026-10-08 合意 |
| スコープ外 | **Mac で GGUF (llama.cpp) を使うこと** (Mac は MLX の方が速く、保守・バイナリサイズの負担も増えるため計画に入れない)、Mac の ASR 変更、Store/MSI、管理者権限のウィンドウへの入力 (案内のみ)、Windows 用 nix、AMD/Intel/ノートの実測 (未実測は LP に「未確認」と書く) | |

要確認 (着手前に決める):
1. GGUF の置き場所: **自前変換して `minimalcorp/` の HF に公開する** (2026-10-08 合意。`minimalcorp/Qwen3-ASR-1.7B-JA-GGUF`・`minimalcorp/Qwen3-ASR-1.7B-GGUF`)。アップロード用のファイル・モデルカードは準備済み (Phase 3a)。公開はユーザーの操作
2. Vulkan 版 llama-server を installer に同梱するか初回に取得するか (§8)。CPU 同意後の CPU 版は取得で良いか

## 3. UX 不変条件 (両 OS で同じ)

| # | 不変条件 | 確認 |
|---|---|---|
| U1 | ショートカット / パネルのボタン / トレイメニューで ON/OFF できる。押下の分岐 (常時→OFF、1回ずつ・未発話→取り消し、発話中→確定して OFF) | E2E + 実機 |
| U2 | `continuous` / `oneShot` の挙動 (1発話で自動 OFF、誤検出では OFF にしない、10 秒無発話で OFF) | 単体 (Rust) + 実機 |
| U3 | 発話ごとに VAD で切り出し、話し終わりに入力。入力は単一キューで直列 | 単体 + 実機 |
| U4 | リアルタイムプレビュー (0.8s 以上伸びたら再送、確定後 750ms 表示、長い発話の区切り) | 単体 (パイプライン) + 実機 |
| U5 | 音声コマンド: 発話全体が正規化後に完全一致した時だけ。既定の対応 (確定/エンター→Enter、改行→Shift+Enter、送信→**送信キー**) | 単体 + 実機 |
| U6 | 入力しないアプリ: 前面にある間は入力せず「このアプリには入力しません」 | 実機 |
| U7 | 入力前後でクリップボードを元に戻す。IME の状態 (変換中・オン/オフ) に影響されず化けない・二重にならない | 実機 (メモ帳・VS Code・Chrome・Word・Teams/Slack) |
| U8 | パネルは**フォーカスを奪わない** (クリック・ドラッグ・右クリックで入力先のフォーカスと IME の変換中の文字を保つ)。常に最前面、位置は記憶、複数ディスプレイで画面内に収まる | 実機 (最優先のリスク) |
| U9 | 常駐 (パネル + トレイ)。ウィンドウ (設定・セットアップ) を開いている間だけタスクバー/Dock に出る | 実機 |
| U10 | ログイン時に起動 (オン/オフ)。システム側での変更 (オフ・承認待ち) を設定に取り込む。登録・解除は利用者の操作の時だけ | 実機 |
| U11 | 再度の起動 (2 つ目のプロセス) は既存のプロセスに知らせて終了し、設定 (未完了ならセットアップ) を開く | 実機 |
| U12 | 初回セットアップの順序と内容 (§5)。進捗・一時停止・再開・中止、再試行、動作確認 | E2E + 実機 |
| U13 | モデルの管理 (取得・選択・削除、取得中は 1 つ)、ストレージ表示、「実行環境とモデルのみ削除」 | E2E + 実機 |
| U14 | アップデート (裏で取得 → 「再起動してアップデート」→ 再起動後もセットアップ済み) | 実機 |
| U15 | アンインストールでデータ・ログ・自動起動の登録が残らない | 実機 |
| U16 | 設定画面の項目・順序・意味は同じ。OS 固有の語だけ置き換える (§4 の文言) | E2E |
| U17 | エラーの出し方 (パネル・トレイ・設定) と復旧操作の種類が同じ | E2E |
| U18 | プライバシー: 音声・認識結果・context をログに出さない。送信先は初回セットアップとアップデートの確認だけ | コードレビュー |

## 4. Mac / Windows の分岐一覧

「共通」は同じコードで動く部分。「境界」は分岐を置く場所。

### 4.1 Rust (`apps/desktop/src-tauri/src/`)

| 領域 | Mac (今) | Windows | 境界 |
|---|---|---|---|
| 入力 | クリップボード退避 → ⌘V (CGEvent) → 復元 | クリップボードの**全形式**を退避 → テキストを置く (履歴・クラウド同期から外す形式 `ExcludeClipboardContentFromMonitorProcessing` / `CanIncludeInClipboardHistory=0` / `CanUploadToCloudClipboard=0` を付ける) → `SendInput` で Ctrl+V → 復元。復元は貼り付け完了を待つ。前面が管理者権限のアプリなら UIPI で届かないため `insert_failed` で案内 | `platform::insert` (`InsertBackend`) |
| 音声コマンドのキー | CGEvent | `SendInput` (VK コード)。`cmd` は Win キー | `platform::keys` |
| 前面アプリ・一覧 | NSWorkspace (bundleId, 名前) | `GetForegroundWindow` → `QueryFullProcessImageNameW` (実行ファイル名、小文字)。一覧は `EnumWindows` の可視トップレベル。表示名は `FileDescription`、無ければ exe 名 | `platform::apps` |
| パネル | NSPanel (non-activating)、`_setPreventsActivation:` | `focusable(false)`・最前面・タスクバー非表示 + `WS_EX_NOACTIVATE` / `WS_EX_TOOLWINDOW`。座標は y 下向きに換算、モニターの**作業領域** (タスクバー除く) に収める。`geometry` (純粋関数) は共通 | `platform::panel` |
| パネルの右クリック | NSMenu | Tauri/muda のポップアップメニュー | `platform::panel` |
| トレイ | NSStatusItem、テンプレート画像、状態は文字の行 | 状態ごとの PNG を `set_icon`。ライト/ダークは `SystemUsesLightTheme`。状態・エラーは無効化したメニュー項目。左クリックも右クリックも同じメニュー | `tray.rs` + `platform::tray` |
| 権限 | マイク (TCC)・アクセシビリティ | **アクセシビリティは無い** (`accessibility` は常に true、UI に出さない)。マイクは設定 > プライバシー > マイクの状態を読み、拒否なら `ms-settings:privacy-microphone` を開く。実際に録音できるかは cpal のエラーでも判定 | `platform::permissions` |
| ログイン時起動 | `SMAppService` | HKCU `...\Run` に登録。`StartupApproved\Run` の無効状態を「承認待ち」相当として読む。案内は `ms-settings:startupapps` | `autostart.rs` |
| Dock / アクティベーション | Accessory ⇄ Regular | 不要 (ウィンドウを開けばタスクバーに出る) | cfg |
| 再度の起動 | `RunEvent::Reopen` + single-instance | single-instance のコールバックのみ | `lib.rs` |
| フォルダ・ゴミ箱 | NSWorkspace / trashItem | `ShellExecuteW` (エクスプローラー) / `SHFileOperationW` (FOF_ALLOWUNDO) | `platform::shell` |
| 子プロセス | env 最小限、`PATH=/usr/bin…` | `CREATE_NO_WINDOW`。env は `SystemRoot` `TEMP` `TMP` `USERPROFILE` `LOCALAPPDATA` `PATH`(System32) のみ。**Job Object (`KILL_ON_JOB_CLOSE`) に入れる** (macOS の stdin EOF 終了に相当。アプリが落ちても残さない) | `platform::process` |
| パス・symlink | `std::os::unix` | シンボリックリンクは使わない。HF のスナップショットは**コピー** (Windows の symlink は権限が要るため)。ディスク使用量は二重に数えない | `paths.rs` `hf.rs` `storage.rs` |
| 更新の置き場所判定 | `.app` / `/Volumes` / App Translocation | 判定なし (常に更新可)。書き込めない場所なら updater のエラーを表示 | `update.rs` |
| 設定の形 | `excludedApps[].bundleId`、`panelPosition.displayId` (CGDirectDisplayID) | `bundleId` に exe 名 (小文字)、`displayId` にモニターのデバイス名。キー名は変えない。修飾キー `cmd` = Win、既定の送信 = Ctrl+Enter | `settings.rs` |
| 既定ショートカット | `Alt+Space` | `Alt+Space` (Mac と同じ。決定済み)。ウィンドウメニューは、登録中は渡らず、記録中は抑止し、修飾キーの単独押下 (メニューモード) は割り当てのないキーを挟んで防ぐ (`sysmenu.rs`)。PowerToys Run・ChatGPT デスクトップ等も既定で使う (競合したら設定で変更。セットアップの完了画面で案内)。Windows は `RegisterHotKey` が他アプリと衝突すると失敗するため、`ShortcutStatus.error` で表示できる (Mac との差) | `shortcut.rs` |

### 4.2 ASR (`provisioning/` `asr_process.rs` `asr.rs`、`asr-server/`)

| | Mac | Windows |
|---|---|---|
| 実装 | Python + MLX (`mlx-qwen3-asr`) | `llama-server` (同梱 Vulkan 版。CPU は同意後に取得) |
| 起動 | `venv/bin/python -m mukuchi_asr` | `llama-server.exe -m <q8.gguf> --mmproj <mmproj.gguf> --device <VulkanN or none> -ngl 99 --port <空き> --host 127.0.0.1 -c 4096 --no-webui` |
| 準備完了 | `GET /health` | 同 (`/health`)。読み込み完了まで 200 を返さない |
| 認識 | `POST /transcribe` (WAV, `language`, `context`) | Rust の ASR クライアントが `/v1/chat/completions` を呼ぶ。`context` は system メッセージ、WAV は `input_audio` (base64)、`temperature=0`。応答の `language X<asr_text>` 接頭辞を除く。**`filters.py` (ハルシネーション除外) を Rust に移植**し、Mac のテストケースを流用して同じ結果になることを確認 |
| 直列実行 | 専用スレッド | クライアント側のキューで直列 (リクエストを重ねない) |
| 遅延の計測 | サーバーの `elapsed_ms` | クライアントで計測 (プレビューの見積もり学習に同じ値を使う) |
| 異常終了 | 3 回まで自動再起動 | 同じ |
| モデル | MLX 8bit (`ja-8bit`・`base-1.7b-8bit`) | GGUF Q8_0 + mmproj Q8_0 (1 モデルに GGUF 2 ファイル)。リポジトリ ID・revision を固定、sha256 検証。`CATALOG` を OS ごとにし (cfg)、`hf.rs` の取得対象に `.gguf` を足す。`model_order(Locale)` は Windows の id で `ja = [ja-gguf, base-gguf]`、`en = [base-gguf, ja-gguf]` (Mac と同じ形) |
| 話す言語 | `language` を query で渡す (ja → `Japanese`、en → `English`、常に明示) | `language {言語}<asr_text>` を assistant の prefill (`continue_final_message`) で渡す。常に明示 |
| 暴走の防止 | サーバー側 | **`max_tokens` を音声の長さから見積もって制限**し、繰り返し (同じ語句が連続) を検出して捨てる。元の Qwen は無音を日本語指定で送ると 256 トークンまで「自分の心に」を繰り返した (実測)。VAD を通った音声だけ送る設計は維持 |
| ログ | `asr-server.log` | `asr-server.log` (llama-server の標準出力を同じローテーションで) |

`ASR クライアント` は `trait AsrBackend` の背後に置き、`MlxServer` (Mac) と `LlamaServer` (Windows) を OS で選ぶ。パイプライン (VAD・プレビュー・コマンド判定・入力) は `AsrBackend` だけを見る。これで §3 の U2〜U5 を OS 非依存のテストで保証する。

### 4.3 フロントエンド (`apps/desktop/src/`) — i18n に合わせる

文言は main の i18n の仕組み (`src/i18n/{ja,en}.ts`、ja の型 `Messages`、en は `satisfies Messages`、`provider.tsx` の `t`) に載せる。**OS 固有の文言は辞書の中に持つ** (コンポーネントに `if (platform === …)` を散らさない)。

- `AppInfo.platform: "macos" | "windows"` を追加し、`usePlatform()` で取れるようにする (起動時に 1 回。`get_app_info`)
- 辞書に OS 別の枝を許す型を足す: `type PerOs<T> = { macos: T; windows: T }`。OS で変わる文言・キー表記だけ `PerOs` にし、使う側は `t.xxx[platform]` (ヘルパー `os(t.xxx)`)。**OS で変わらない文言は 1 つのまま**。キーの追加は ja に書けば型で en にも要求される (欠落はビルドで落ちる)
- Rust 側の辞書 (`src/i18n/` の Locale ごとの `match`: トレイ・メニュー・エラー文言) は、OS は**ビルド時に決まる**ので、`match` の腕の中で `cfg!(target_os)` または OS ごとの関数に分ける。Windows のトレイ文言 (「タスクトレイ」)・権限の案内・エラー文言は ja/en 両方を足す。表示言語の切り替え時にトレイを作り直すのは Mac と同じ
- 表示言語と話す言語は Mac と同じ UX (Welcome の 2 つの Select、設定 > 一般・認識)。Windows の OS の言語 (`GetUserDefaultLocaleName`) で初期選択する。**話す言語でモデルが決まる**ので、セットアップの容量表示も言語ごと (ja 約 2.19GB・en 約 2.52GB)。設定 > 認識の並び・「推奨」バッジ・「日本語向けに調整」も Mac と同じ
- 音声コマンドの既定は話す言語ごと (ja: 確定・エンター・改行・送信 / en: enter・new line・send) に、**送信キーを OS で変える** (Mac ⌘+Enter、Windows Ctrl+Enter)。既定の組み立ては Rust の 1 か所

| 箇所 | Mac | Windows |
|---|---|---|
| 修飾キーの表示・記録 (`shortcut.ts` `format.ts` `shortcut-recorder.tsx`) | ⌃⌥⇧⌘ | Ctrl / Alt / Shift / Win |
| 常駐場所の語 | メニューバー / menu bar | タスクトレイ / system tray |
| ファイルを開く | Finder で開く / Reveal in Finder | エクスプローラーで開く / Show in Explorer |
| 権限 (`PermissionsSection` `SetupWindow` ステップ 2 `error-actions.ts`) | マイク + アクセシビリティ | マイクのみ。アクセシビリティの行・エラーを出さない |
| ログイン項目の案内 (`launch-at-login-error.tsx`) | システム設定 > ログイン項目 | 設定 > アプリ > スタートアップ |
| 入力しないアプリ | アプリ名 (bundleId) | アプリ名 (exe 名を補助表示) |
| ストレージ/アンインストール文言 | .app をゴミ箱へ | 「設定 > アプリ」またはアンインストーラーから (§8) |
| `window-frame.tsx` | 信号機ボタンの余白 | 余白なし |
| 「この Mac」「Apple Silicon GPU」 | 同左 | 「この PC」「GPU」 (en: "this PC") |
| mock / Playwright | WebKit | **chromium プロジェクトを追加**。mock に platform と GPU の状態のシナリオを足す |
| スクリーンショット (`pnpm screenshots`) | `e2e/screenshots/{ja,en}/` | `{ja,en}/` を OS ごとに分ける (`mac/`・`windows/`)。**既存の Mac の撮影結果は差分なし**を維持。英語は文字列が長いので Windows でも崩れを確認 |

### 4.4 開発・ビルド・CI・LP

| 領域 | 内容 |
|---|---|
| Rust の cfg | `lib.rs:9` の `mod macos` を `#[cfg(target_os = "macos")]` にし、`src/platform/{mod,macos,windows}.rs` を窓口に。`objc2` `tauri_nspanel` 依存の呼び出しはすべて窓口経由 |
| CI | `ci.yml` に `windows-latest` の cargo fmt/clippy/test と、フロントの lint/typecheck/chromium Playwright。Mac のジョブは変えない |
| ビルド資材 | Windows 用に `prepare-bundle-resources` を Node 化 (または PowerShell 版)。llama-server (b11408、sha256 固定) を取得。`verify.wav` は Mac で作ったものをリポジトリ外のアーティファクトで受け渡すか、Windows 用に別途 (TTS は SAPI Haruka で作れる) |
| `tauri.conf.json` | `bundle.targets` に `nsis`、`icon.ico`、`bundle.windows.nsis.installMode=currentUser`、`webviewInstallMode`、resources に llama-server |
| リリース | `release.yml` に `build-windows` (GitHub ホストの `windows-latest`)。NSIS → minisign → Release 添付。`scripts/sign-updater.mjs` を複数プラットフォームに対応させテストを直す。Environment の承認は先頭 1 回のまま |
| LP | §10 |

## 5. 初回セットアップ (オンボーディング) — Windows

Mac の 6 ステップ (ようこそ → 権限 → ダウンロード → 入力モード → 試し話し → 完了) の**順序と見た目は同じ**。Windows では次だけが変わる。

| ステップ | Mac | Windows |
|---|---|---|
| 1 ようこそ | 表示言語・話す言語の Select (OS の言語で初期選択)。「この Mac の中で行い…」 | 同じ (OS の言語で初期選択)。「この PC の中で行い…」。**この間に裏で GPU 判定 (§5.1) を始める** |
| 2 権限 | マイク → アクセシビリティ | マイクのみ。拒否なら `ms-settings:privacy-microphone` を開く案内。許可すると自動で反映 (1 秒ごとの再取得は同じ) |
| (GPU 確認) | なし | **問題がある時だけ**差し込む画面 (§5.1)。GPU が使えるなら出さない |
| 3 ダウンロード | runtime (uv・Python 依存) → model (話す言語の推奨、約 2.2GB) → verify | runtime = llama-server の配置 (同梱を展開/検証) → model (話す言語の推奨の GGUF 2 ファイル。ja 約 2.19GB・en 約 2.52GB) → verify。表示の形・一時停止/再開/中止は同じ |
| 4 入力モード | 同じ | 同じ |
| 5 試し話し | 同じ。パネルを表示 | 同じ。ショートカットの表示が Windows の既定 |
| 6 完了 | ログイン時起動の反映 | 同じ (レジストリに登録) |

### 5.1 GPU の判定と CPU 実行の同意

要件: **GPU を積む利用者の UX を 1 画面も増やさず、本当に GPU が使えない時だけ止める**。判定は 2 段階で、結果に応じて分ける。

判定の仕組み (WINDOWS_DECISION.md の実測): 
- (a) DXGI `EnumAdapters1` でソフトウェアアダプター (`DXGI_ADAPTER_FLAG_SOFTWARE`、Microsoft Basic Render Driver) を除いたアダプターを数える。独立/内蔵は D3D12 の `UMA` で区別。ダウンロード前に動く
- (b) 同梱の Vulkan 版 `llama-server --list-devices` で推論に使えるデバイスを確定 (正)。本機では GPU あり/擬似なしで `Vulkan0: …` / `(none)` を確認済み

| 結果 | 条件 | 動作 |
|---|---|---|
| `ok` | (b) に独立 GPU がある | 何も出さずに進む。複数ある時は独立 GPU を優先して `--device` を 1 つに固定 (ハイブリッド ノートで分割・内蔵 GPU に落ちるのを防ぐ。未検証) |
| `integrated` | (b) に内蔵 GPU のみ | 進める (確認画面は出さない)。速度は未検証のため、**動作確認 (verify) の実測遅延が閾値を超えたら**非ブロックで「この PC では認識に時間がかかります」を表示 (安全網) |
| `driver_missing` | (a) にハード GPU がいるのに (b) が `(none)` | GPU の有無ではなくドライバー/Vulkan の問題。**ドライバー更新の案内**と「再検出」、「CPU で続ける」(同意へ) |
| `none` | (a)(b) ともに GPU なし | **同意画面**: 「GPU が見つかりません。CPU でも動きますが、認識に 1〜3 秒以上かかり、使い心地が大きく下がります。GPU のある PC での利用をおすすめします。」[CPU で続ける (同意)] [やめる]。[再検出] とドライバー更新の案内を併記 |

- 同意は `Settings.cpuInferenceAccepted` に記録 (§7)。同意するまで**モデル (約 2.2〜2.5GB) も CPU 版の取得も始めない**
- 同意後は CPU 版 llama-server (取得、sha256 固定、約 18MB) を使う。以後の起動でも毎回判定し、**GPU が使えるようになっていれば自動で GPU に切り替える** (同意は不要)
- 起動時に GPU が見えなくなった (リモートデスクトップ、ドライバー不具合、eGPU の取り外し等): 同意済みなら CPU で続行。**未同意なら**起動を止めてエラー `gpu_unavailable` (復旧操作: 「CPU で続ける」→ 同意画面 / 「再検出」)
- 誤判定の逃げ道: 再検出、ドライバー更新の案内、ログ (`asr-server.log` と `gpu-probe` の結果、デバイス名のみ)
- 判定結果は `get_gpu_status` で返し、設定 > 認識 に「使用中のデバイス」を表示 (GPU 名 / CPU)

**LP では判定しない**: ブラウザからの GPU 判別は不確実 (Firefox は丸める、Chromium でもハードウェアアクセラレーション無効やノートの内蔵 GPU 選択で誤る)。LP は静的に「GPU 推奨・CPU のみは非推奨」と書き、判定と同意はアプリ内で行う。

## 6. 実行時の処理 (音声入力 1 発話の流れ)

OS 非依存の部分 (cpal 録音 → Silero VAD → 切り出し → プレビュー → コマンド判定 → キュー) は共通。差が出るのは両端だけ。

```
[共通] cpal 録音 → VAD → 発話確定 ─┐
                                    ├→ AsrBackend (Mac: MlxServer / Windows: LlamaServer) → テキスト
[共通] 音声コマンド判定 ←────────────┘
        │ コマンド → platform::keys (Mac: CGEvent / Windows: SendInput)
        │ 文字   → 入力しないアプリ判定 (platform::apps) → platform::insert
```

| 点 | 確認 |
|---|---|
| マイク: cpal は WASAPI。既定デバイスの変更・抜き差しの検知 (2 秒ポーリング) は共通コード | 実機 |
| 日本語 IME オン/変換中に貼り付けて化けない・二重にならない。入力前に IME 状態を触らない | 実機 (最初の 3 検証の 1 つ) |
| クリップボードの復元: 画像・ファイル等の全形式、履歴への残り方、貼り付け先の読み取りが終わる前に戻さない | 実機 |
| 前面が管理者権限: `insert_failed` とメッセージ (「管理者として動いているアプリには入力できません」) | 実機 |
| 全角/半角キーや IME のキー: 音声コマンドの対象外 (今の対応表のまま) | - |

## 7. インターフェースの変更 (architecture.md を先に更新する)

| 追加 | 内容 |
|---|---|
| `AppInfo.platform` | `"macos" \| "windows"` |
| `Settings.cpuInferenceAccepted` | boolean、既定 false (Mac では使わない)。§5.1 |
| `GpuStatus` / `get_gpu_status` / `probe_gpu` | `{ kind: "ok" \| "integrated" \| "driver_missing" \| "none"; devices: { name; vramMb; integrated }[]; selected: string \| null; device: "gpu" \| "cpu" }`。`probe_gpu` は再検出 |
| `AppError.code` | `gpu_unavailable` を追加。`accessibility_denied` は Windows では発生しない。action に `accept_cpu` / `probe_gpu` |
| `Permissions.accessibility` | Windows は常に true |
| `open_system_settings.pane` | `microphone` → `ms-settings:privacy-microphone`、`login_items` → `ms-settings:startupapps`、`accessibility` は Windows では使わない |
| `ProvisioningStatus.items[].id` | `runtime` は Windows では「llama-server の配置」 (id は据え置き。表示名だけ OS で変える) |
| 識別子・パス・アンインストールの節 | Windows の表を足す (`%LOCALAPPDATA%`、レジストリ、NSIS) |
| `ModelInfo` / `CATALOG` | 各候補に `backend: "mlx" \| "gguf"` と `supported_on` (OS・CPU)。**`supported_on` を満たさない候補は `list_models` に出さない**。OS ごとの候補 (cfg)。Windows: `ja-gguf` (tunedFor ja)・`base-gguf` (元のモデル)。`model_order` は ja = [ja-gguf, base-gguf]、en = [base-gguf, ja-gguf]。`size_bytes` は 2 ファイルの合計 (公開後に tree API の値で確定)。リポジトリ・revision は HF 公開後に確定 (それまでは Mac と同じ仮の値の規則で `TODO-i18n-pin-commit` を使い、リリースを止める (§9)) |
| `Settings.speechLanguage` / `uiLanguage` | 変更なし (Mac と同じ)。Windows で ASR に渡す `language` の元 |
| 開発用環境変数 | `MUKUCHI_DEV_FORCE_GPU=none\|integrated\|driver_missing` で判定結果を差し替え (同意フローの確認用。デバッグビルドのみ) |

## 8. 配布・アップデート・アンインストール

- **インストール**: NSIS (`currentUser`)。インストール先は `%LOCALAPPDATA%\mukuchi` (Tauri 2.12 の NSIS テンプレートの既定 `$LOCALAPPDATA\${PRODUCTNAME}`。`Programs\` の下ではない)。Vulkan 版 llama-server (展開後 91MB、zip 31MB) は同梱する案。**同梱が前提** (GPU 判定 (b) が初回のネットワークなしで動く)。要確認事項に挙げる
- **アップデート**: NSIS インストーラーが updater の成果物。`install_update` は音声入力 OFF → updater の install (アプリが終了してインストーラーが走る) → 再起動、の流れを実機で確認 (Mac の「.app の置き換え」とは違うため、再起動までの時間と失敗時の状態を確かめる)。更新後に llama-server の版 (sha256) が変わったら実行環境を入れ直す (Mac の runtime の版判定と同じ)
- **アンインストール**: 「完全にアンインストール」(設定 > ストレージ) は `uninstall.exe` を起動してアプリを終了する。NSIS のフック (`NSIS_HOOK_POSTUNINSTALL` 等) で `%LOCALAPPDATA%\<ID>` (データ・モデル・WebView2 のデータ)・ログ・HKCU の Run と `StartupApproved\Run` を削除する。Tauri の標準の「アプリデータを削除」チェック (`$APPDATA\<ID>`・`$LOCALAPPDATA\<ID>`) は `/P` では入らないため、`/MUKUCHI_PURGE` を見てフックで有効にする。StartupApproved はテンプレートが消さないためフックで消す (役割の分担は architecture.md「同梱物・配布 (Windows)」)。「実行環境とモデルのみ削除」は Mac と同じ動作
- **削除の安全策** (目印 `.mukuchi-data`、`MUKUCHI_DEV_DATA_DIR` の条件、dev ID での dry-run) は Windows でも同じ。パスの比較は大文字小文字を区別せず、`\\?\` と 8.3 短縮名を正規化
- **ライセンス** (2026-10-08 確認): Qwen/Qwen3-ASR-1.7B・neosophie/Qwen3-ASR-1.7B-JA はともに HF のメタデータが Apache-2.0 (Qwen の GitHub も Apache-2.0)。変換物 (GGUF) の再配布は Apache-2.0 §4 に従い、`LICENSE` の同梱・変更の表示 (§4(b))・元の出典をモデルカードに書く (準備済み)。**neosophie は LICENSE ファイルが無く、学習データを明記していない** (Mac 側で既に公開しているものと同じ前提。残るリスクとして認識)。llama.cpp は MIT。同梱する DLL に **jsonhpp (MIT)** と **LLVM OpenMP `libomp.dll` (Apache-2.0 with LLVM exception)** が含まれるため、`THIRD_PARTY_NOTICES`・`licenses/` に llama.cpp の LICENSE・`LICENSE-jsonhpp`・`LICENSE-LLVM-OpenMP` を入れる。`vulkan-1.dll` は GPU ドライバー側のもので再配布しない。**CUDA ランタイムは同梱しない** (NVIDIA の再配布条件が別。将来 CUDA 版を足す時に確認)。LibriSpeech (CC BY 4.0) は評価にのみ使い、再配布しない (モデルカードに出典を書く)
- **VC++ ランタイム** (2026-10-10 決定・実装): llama-server (と DLL) は `vcruntime140.dll`・`vcruntime140_1.dll`・`msvcp140.dll` に、**mukuchi.exe も `msvcp140.dll`・`msvcp140_1.dll` (ort 由来) に依存する** (PE の import で確認)。NSIS で再頒布可能パッケージを入れる方式は管理者権限が要るため、**app-local で同梱** (`llama-server/` に 3 つ、インストール先の直下に 4 つ)。取得元は Microsoft の再頒布可能パッケージ 14.44.35112 の版付き URL (exe と各 DLL の sha256 を固定。`fetch-vc-runtime.mjs`)。依存の解決は `check-windows-dlls.mjs` で機械的に確認 (CI・リリースで実行)。クリーンな環境 (VM 等) での起動は**未検証**。CPU 版 (`llama-cpu/`) にも同じ 3 つが要るため、runtime の導入時に同梱の `llama-server/` から写す (`provisioning/llama_runtime.rs`)。根拠・手順は docs/release.md の「Windows」
- **署名なし**に伴う案内: 初回に SmartScreen の警告が出る (「詳細情報 → 実行」)。**Smart App Control が有効な PC では起動できない** (回避手段なし)。LP とリリースノートに明記 (§10)

## 9. リリース手順への影響 (`docs/release.md` に Windows の節を足す)

1. Actions > Release (target=desktop) で、macos-15 と windows-latest を**並行**でビルド
2. 両方が成功した時だけ、Release に `mukuchi_aarch64.dmg` / `mukuchi_aarch64.app.tar.gz` / `mukuchi_x64-setup.exe` / 各 `.sig` / `latest.json` (2 プラットフォーム) を添付して公開。片方でも失敗したらタグも版上げも行わない
3. LP の Windows ボタンは `…/releases/latest/download/mukuchi_x64-setup.exe` を指す (Latest は常に desktop の Release のため、web のデプロイでは変わらない)。LP の deploy は別
4. 署名の工程は無い。将来、証明書が取れたら `build-windows` に署名の工程を足す (minisign はその後)
5. **リリース前チェック** (`scripts/check-release-blockers.mjs desktop`): 配布してはいけない仮の値 (HF 未公開のモデルの revision のプレースホルダ `TODO-i18n-pin-commit*`) がソースに残っていれば失敗する静的な検査 (実機の動作確認ではない)。Windows のカタログ (`provisioning/models.rs` の cfg(windows) の定義) も同じ印で対象に入れ、Windows の GGUF が HF に公開され commit が固定されるまでリリースできないようにする。release.yml の prepare と `make build` で実行される。**2026-10-08 時点で、この PC (rebase 後の main) で実行して通る** (プレースホルダなし)。Windows の GGUF の定義を足したら、この検査を再実行して仮の値で止まること、本物の commit に替えて通ることを確かめる

## 10. LP (`apps/web`) — Windows 追加と全体最適 (ja/en)

方針: **「Mac に常駐する」前提の文言を、OS 非依存の価値 (常駐・端末内で処理・自分の声で入力) に直し、OS ごとに変わる情報だけを OS ごとに出す**。単に Windows の行を足すのではなく、ページ全体を「Mac / Windows の 2 OS のアプリ」として整える。ja/en の辞書 (`app/i18n/{ja,en}.ts`) を両方更新し、en の校正はユーザー確認 (i18n-plan の手順 6 と同じ)。

### 10.1 設計の前提

- ページは**事前生成 (SSG)** なので、HTML は OS 中立にする。閲覧 OS は既存の `detectPlatform` (クライアント) で決め、(a) 主ボタン、(b) OS で切り替える部分の初期タブ、を選ぶ。利用者が手で切り替えられる (「macOS / Windows」のタブ)。JS なし・クローラーには**両 OS の内容が HTML に入っている** (タブの中身を両方出す。動作要件は 2 表を並べる)
- `platform.ts`: `windows` を `windows-x64` / `windows-arm` に分ける (UA-CH の `architecture` が取れる Chromium 系のみ。Safari・Firefox は取れないので x64 とみなしてダウンロード可 + 注記。Mac の `mac-unknown` と同じ考え方)。ARM の Windows は非対応のボタン
- **公開の切り替え**: `site.ts` に `WINDOWS_AVAILABLE` (既定 false) を置く。false の間は今と同じ「Windows 版は準備中」。Windows の Release が公開されて `mukuchi_x64-setup.exe` が実在してから true にして LP を deploy する (リンク切れのボタンを出さない)。文言の OS 中立化は先に出してよい

### 10.2 箇所ごとの変更

| 箇所 | 今 | 変更 |
|---|---|---|
| meta (title・description・OG・`shareText`・`ogImageAlt`) | 「Mac に常駐する…」「Mac 用の…」 | OS 中立 (「常駐する音声入力アプリ」「Mac / Windows 対応」)。OG 画像は ja/en とも作り直し (Mac の語を含む場合)。構造化データがあれば `operatingSystem` を両 OS に |
| ヒーロー (`hero.body`・`macOnly`) | 「Mac に常駐…」「Mac 用のアプリです。Mac のブラウザで…」 | 中立の本文 + 対応 OS の表示。`macOnly` は「Mac または Windows の PC のブラウザで開くとダウンロードできます」 |
| ダウンロードボタン (`cta.tsx`) | 「Mac 版をダウンロード」/ Windows は「準備中」 | OS ごとの状態: mac-arm・mac-unknown・windows-x64 = ダウンロード、mac-intel・windows-arm = 非対応 (理由を note)、linux・other・mobile = 「Mac / Windows 版のみ」+ 両 OS のリンクと URL 共有。補助リンク「もう一方の OS 版」を出す (別の PC で使う人向け) |
| ダウンロードの補足 (`downloadMeta`) | `v… ・ 無料 ・ Apple Silicon（M1 以降）専用 ・ 36 MB` | OS ごと (Mac: 同左 / Windows: `v… ・ 無料 ・ Windows 11 (64 bit) ・ 〇〇 MB`)。サイズは `site.ts` に OS ごとの定数 |
| Windows の署名なしの案内 | なし | ボタンの直下に短い注記 (「署名前のため、初回に Windows の警告が出ます。詳細情報 → 実行」)。詳しい手順は動作要件の下に折りたたみ。**Smart App Control 有効の PC では起動できない**を明記 |
| 機能の説明 (ショートカット・メニューバー) | 「メニューバーからも…」`⌥Space` | OS で切り替え: メニューバー / タスクトレイ、`⌥Space` / `Alt+Space` (`SHORTCUT_KEYS` を OS ごとに) |
| プライバシー (「音声は Mac の外に出ません」「すべて Mac 上で」) | Mac 固定 | 「この端末の外」「お使いの端末の中」等に中立化。通信の説明 (モデルの取得・更新の確認のみ) は両 OS で同じ。Windows は取得元 (Hugging Face・GitHub) が同じ |
| デモ (`demo.tsx`) の「送信 → ⌘ + Enter」・Mac 風の見た目 | Mac | キー表記を OS で切り替える。Mac 風の画面 (メニューバー・信号機) がある場合は Windows 版の見た目 (トレイ) を用意する、または OS 中立の見た目にする (作業量を見て決める。**未調査**: 実装に入る前に `demo.tsx` を確認) |
| セットアップ手順 (`setup.steps`) | dmg → アプリケーションフォルダ、「マイクとアクセシビリティ」 | OS 別 (タブ): Windows は「インストーラー (exe) を実行 (警告が出たら 詳細情報 → 実行)」「マイクを許可」。アクセシビリティは出さない。モデル取得の行は話す言語のモデルと容量 (Mac / Windows で容量が違う) |
| 動作要件 (`requirements`) | Mac のみの 1 表 | **macOS と Windows の 2 表**。Windows: OS = Windows 11 (64 bit)、GPU = **推奨** (Vulkan 対応、VRAM の目安は実測で確定)、動作確認 = RTX 3080 Ti / Core i9-12900KF のみ (他は「未確認」と書く)、メモリ・空き容量、**CPU のみは非推奨** (同意の上で使える。1〜3 秒以上かかる目安)。「動作確認済み」と「目安」を書き分ける |
| 標準モデル (`MODELS` in `site.ts`) | ja・en の 2 値 (Mac の容量) | **OS × 言語の 4 値** (Mac は既存、Windows は ja 約 2.19GB・en 約 2.52GB の暫定値。公開後に tree API の値で確定)。名前は同じ (「Qwen3-ASR 1.7B」) |
| 版・サイズ (`DMG_SIZE_MB`) | dmg の実測 | OS ごと (`DMG_SIZE_MB`・`NSIS_SIZE_MB`)。Windows 版は同梱物 (llama-server) の分だけ大きくなる |
| プラットフォーム一覧 (`platforms`) | macOS（Apple Silicon）= 提供中、Windows = 準備中 | 両方「提供中」(`WINDOWS_AVAILABLE` 後)。「Windows 11（x64）」 |
| 最終 CTA・`finalCta.leadMobile` | 「Mac のブラウザで…」 | 「Mac または Windows の PC のブラウザで…」 |
| GA | `file_extension` = dmg 固定 | `dmg` / `exe`、`platform` を追加 |
| フッター・FAQ | - | 「対応 OS」を追加。Windows の警告・GPU の FAQ を 1〜2 件 (Smart App Control、GPU がない PC) |
| 公開 (SignPath 用の Code signing policy ページ) | - | **不要** (署名なしのため) |

### 10.3 検証 (LP)

- `pnpm test` (apps/web、chromium): ja・en × (mac UA / windows-x64 UA / windows-arm UA / linux UA / mobile UA) で主ボタンと注記、`WINDOWS_AVAILABLE` の true/false の両方、タブの初期選択と手動切り替え、HTML に両 OS の動作要件が含まれること、`hreflang`・`canonical` は変えないこと
- 事前生成の HTML に `Mac` だけの文言が残らない (grep のテスト)。en は文字列の長さで崩れないことをスクリーンショットで確認
- `docs/plans/lp-spec.md` と `e2e/lp.spec.ts` (platform の 182-186 行付近・要件・CTA) を直す
- 「Mac の語を含むべきではない箇所」の一覧 (上の表) を完了条件にする

## 11. フェーズ

各フェーズの「完了」を満たしてから次へ進む。担当は `.claude/agents/` の subagent (領域をまたぐ変更は §7 を先に更新)。

| P | 内容 | 担当 | 完了の条件 |
|---|---|---|---|
| 0 | ASR の実機検証と方式決定 | asr-server-engineer | **済み** (WINDOWS_DECISION.md。話す言語ごとのモデル・GPU 判定・CPU の扱いを含む)。残: 自分の声での認識、コールド起動、30 秒超、`max_tokens`・繰り返し検出の方式 |
| 0.5 | 開発環境: Windows に rustup + MSVC + pnpm + Node。GPU 判定の最小実装 (DXGI + `--list-devices`) を実機で | devenv-engineer + rust-engineer | 本機の `ok`。`MUKUCHI_DEV_FORCE_GPU` で 4 状態が出せる。`cargo build` が Windows で通る |
| 1 | §7 の先行更新 → Rust のクロスプラットフォーム化 (cfg・`platform/` 窓口・unix 依存の分離・macOS 専用 API の cfg・テストの cfg) + CI の windows ジョブ | rust-engineer | **Mac の `make lint`・`make test` が今と同じ**。CI の windows で clippy/test が通る (Windows 側はスタブ可) |
| 2a | **リスク先行の最小検証 (実機)**: ① パネルがフォーカスを奪わない (U8) ② 日本語 IME オンでの貼り付け (U7) ③ クリップボードの復元 | rust-engineer | メモ帳・VS Code・Chrome で 3 項目が通る。通らない場合は方式を見直す (クリックを Rust のフックで受ける等) 前に報告して止まる |
| 2b | Windows の OS 依存部の実装 (§4.1 の全行) | rust-engineer | §3 の U1〜U11 を実機で確認 |
| 3a | **GGUF の変換・HF 公開** (ja・en、LLM Q8_0 + mmproj Q8_0、README・LICENSE (Apache-2.0)・変更の表示)。変換・モデルカード・検証は**済み** (`C:\mukuchi-spike\upload\{ja,en}`)。**公開はユーザーが行う** (外部公開)。公開後に revision・`size_bytes` を確定 | asr-server-engineer (手順) + ユーザー | tree API の値が `CATALOG` に入り、`check-release-blockers` が通る |
| 3 | ASR を Windows に組み込む (`AsrBackend`・`LlamaServer`・フィルター移植・`max_tokens`・繰り返し検出・CATALOG・`model_order`・`.gguf`・セットアップの runtime ステップ・GPU 判定と同意 (§5.1)) | rust-engineer + asr-server-engineer | U12・U13。`filters` が Mac のテストと同じ結果。無音・雑音の入力で暴走しない (テスト)。GPU なし (擬似) で同意フローが動き、同意前にモデルを取得しない。ja・en の両方でセットアップが通る |
| 4 | パッケージ・アップデート・アンインストール・リリース (§8・§9) | devenv-engineer + release 担当 | U14・U15。dry run で両 OS の成果物と `latest.json` ができる |
| 5 | フロントエンド (§4.3、i18n の仕組みに載せる) | frontend-engineer | U16・U17。Playwright の webkit のスクリーンショット (ja/en) が**差分なし**、chromium の Windows シナリオ (ja/en) が通る。`Messages` の型で ja/en の欠落がない |
| 6 | LP (§10、ja/en。OS 中立化 → Windows の公開に合わせて `WINDOWS_AVAILABLE` を true) | frontend-engineer | §10.3。ユーザーが en の文面を校正 |
| 7 | 実機の通し確認と公開 | メイン | §12 の全項目 |

Phase 0.5 と 1 は並行できる。2a は 1 の完了後すぐに (最大のリスクのため 2b より先)。3 は 2b と並行できるが、GPU 判定 (0.5) に依存する。

## 12. 検証

**Mac の回帰**: `make lint`、`make test`、desktop の Playwright (webkit) のスクリーンショット差分なし、`make build-local` で .app が起動し、Mac の実機で §3 の U1〜U18 が従来どおり。

**CI**: windows ジョブ (fmt/clippy/test、フロントの chromium Playwright)、Release の dry run (両 OS の成果物・`latest.json` の 2 プラットフォーム・成果物名が固定)。

**Windows 実機 (Windows 11、RTX 3080 Ti)**:
- 新規インストール → セットアップ (取得・一時停止・再開・中止・動作確認)。SmartScreen の警告が出て、「詳細情報 → 実行」で進める
- 入力先: メモ帳・VS Code・Chrome・Word・Teams/Slack。日本語 IME オン/変換中、クリップボードの復元 (テキスト・画像)
- パネル: クリック・ドラッグ・右クリックで入力先のフォーカス・IME の変換中の文字が消えない。マルチモニター、DPI 125%/150%、タスクバーの位置 (上下左右) で位置が合う
- ショートカット (衝突の確認含む)・音声コマンド (確定・改行・送信)・入力しないアプリ・`oneShot`
- ログイン時に起動 (オン/オフ、タスクマネージャーで無効化した状態の取り込み)
- アップデート (旧版 → 新版、再起動後もセットアップ済み)、アンインストール (データ・ログ・Run キーが残らない)
- GPU 判定: `MUKUCHI_DEV_FORCE_GPU` の 4 状態、Vulkan を隠した擬似なし (`VK_DRIVER_FILES`)、同意の前後で取得が始まらない/始まる、GPU 復帰で自動切り替え
- CPU のみ (GPU を隠した状態) で動作環境の値を実測し直す

**未検証 (実機が無い)**: AMD・Intel の GPU、内蔵 GPU のみ、ハイブリッド ノートの列挙順と `--device`、リモートデスクトップ・VM、Smart App Control 有効の PC、弱い CPU。LP には「動作確認済み」と「未確認」を書き分ける。

## 13. リスク

| リスク | 影響 | 対応 |
|---|---|---|
| WebView2 で `WS_EX_NOACTIVATE` がクリック時にも効くか (U8) | 最大。効かないとパネルが使えない | 2a で最初に検証。効かなければ別方式を設計して報告 |
| 日本語 IME での貼り付け (U7) | 文字化け・二重入力 | 2a。Ctrl+V が合わない場合は `SendInput` の `KEYEVENTF_UNICODE` を併用する案 (長文は遅いため最後の手段) |
| 署名なし (SmartScreen・Smart App Control) | 起動できない/怖がられる | LP・セットアップ前の案内を丁寧に。実績が増えたら OV 証明書か SignPath 再申請 |
| GPU の誤判定 | GPU がある人に同意画面が出る | (a)(b) 二段階、`driver_missing` の分離、再検出、判定ログ。`ok` の時は何も出さない |
| 内蔵 GPU・AMD・Intel の速度が未知 | 「遅い」評価 | verify の実測遅延で通知 (安全網)。LP は未確認と明記 |
| Vulkan での複数デバイス分割 (ハイブリッド) | 遅い/不安定 | `--device` を 1 つに固定 |
| 管理者権限のアプリへ入力できない (UIPI) | 入力されない | 検出して案内 (U7) |
| GGUF の公開 (外部公開) | - | 事前に確認を取る。ライセンス (Apache-2.0、`LICENSE` と変更の表示を同梱)。公開までリリースは `check-release-blockers` で止まる |
| 元の Qwen (en の推奨) が無音・雑音で暴走する (実測) | 長い誤入力・遅延 | VAD を通った音声だけ送る + `max_tokens` を音声長から制限 + 繰り返し検出。Phase 7 の実機で VAD の漏れを確認 |
| en のモデルは数字を words で書く (`fifteen thousand dollars`) | 利用者の好みと異なる | Mac と同じ判断 (元のモデルを推奨)。好みは設定 > 認識で ja モデルにも切り替えられる |
| llama.cpp の更新で挙動が変わる | 認識の変化 | 版 (b11408) と sha256 を固定。更新は検証してから |
| NSIS の削除範囲・アップデートの流れ | データが残る/更新に失敗 | 公式ドキュメントと実機で確認 (Phase 4) |
