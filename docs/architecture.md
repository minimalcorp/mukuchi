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

UIデザインの正: Claude Design handoff「mukuchi UI Proposal」(デザインシステム: Minimal Portal)。実装計画は [docs/plans/implementation-plan.md](plans/implementation-plan.md)。

## 決定事項

| 項目 | 決定 | 理由・備考 |
|---|---|---|
| 対象OS | macOS (Apple Silicon, aarch64のみ) | MLXがApple Silicon専用 |
| フレームワーク | Tauri v2 + Rust | 入力送信・常駐の軽さ |
| フロントエンド | React + TypeScript + Vite + Tailwind + shadcn/ui + lucide-react。トークンはMinimal Portal DS (HEX→CSS変数)。フォントはIBM Plex Sans JP / Mono を同梱 (オフラインで動くようGoogle Fontsは使わない) | |
| ダークモード | システム設定に追従。DSにダークトークンがないため、デザインの参考表示(gray 700〜900を面に使用)に従う | |
| 録音 | Rust (cpal) | WebView経由のgetUserMediaは権限ダイアログ二重表示等の既知問題あり |
| VAD | Silero VAD (`ort`、arm64は静的リンク)。差し替え可能なtraitの背後に置く | 代替: earshot |
| ASR | Python + MLX (`mlx-qwen3-asr`)、モデルは `neosophie/Qwen3-ASR-1.7B-JA` を全層8bit量子化したもの(自前変換、約2.2GB。org配下のHFリポジトリに置き revision を固定して取得。配置までは開発で元の bf16 版を使う) | Rust実装(candle/MLX)は約3倍遅い (spikes/asr-bench)。8bitはfp16と同等精度・約2割速い・メモリ1/3 (spikes/asr-bench/MODEL_DECISION.md) |
| 操作 | 音声入力のON/OFFは **常時表示パネルのボタン** と **メニューバー** のみ。**キーボードショートカットは設けない**。押している間だけ録音するモードも実装しない | 2026-09-30 確定 |
| 入力単位 | ONの間、発話(VAD区間)ごとに文字起こしし、話し終わったら入力。入力は単一キューで直列化 | 必須要件 |
| リアルタイムプレビュー | 発話中は前回から音声が0.8秒以上伸び、かつ途中表示の要求が処理中でなければ、発話開始からの音声を文字起こしし直してパネルに表示する。入力するのは話し終わり時点の最終結果のみ。確定後は最終結果で表示を置き換えて2秒間表示する。ただし発話が20秒以上になったら送らず、推論時間の見積もり(実測から学習)が話し終わりの無音(silenceMs)を超える場合も送らない | 2026-09-30 確定。値はtsunagiの音声入力に準拠 (implementation-plan.md「音声入力の体験」)。途中表示の応答待ちを取り消してもサーバーの推論は止まらず(直列実行)、確定がその分遅れるため |
| 入力方式 | クリップボード + ⌘V、元のクリップボードを復元 | IMEの影響を受けない |
| 音声コマンド | 「言い方→キー」対応表(既定: 確定/エンター→Enter、改行→Shift+Enter、送信→⌘+Enter)。発話全体が正規化後に完全一致した時のみ。機能ごとON/OFF可 | 表記揺れは複数の言い方で吸収 |
| 入力しないアプリ | 登録したアプリが前面にある間は入力しない(パネルに「このアプリには入力しません」) | デザインの任意提案Aを採用 |
| メニューバー | macOS標準のメニュー(NSMenu)。状態・エラーは文字の行、復旧はメニュー項目で表す。アイコンは状態別のテンプレート画像(エラー時のみ赤点付きの非テンプレート画像) | デザインの進捗バー・色付き表示は標準メニューで再現できないため |
| 常時表示パネル | フォーカスを奪わないパネル(NSPanel, non-activating。`tauri-nspanel`)。既定は画面下中央(Dockの上16px)、ドラッグで移動し位置を記憶。前面ウィンドウのあるディスプレイに表示。ピルはディスプレイの visibleFrame (Dock・メニューバーを除く) に収める。記憶するのは利用者のドラッグだけ(ディスプレイの取り外し等でシステムが動かした位置は記憶しない) | |
| ログイン時に起動 | `SMAppService.mainAppService` (macOS 13+) で登録。登録・解除するのは利用者の操作の時だけ: セットアップ完了時 (その時点の launchAtLogin に揃える) と、完了後に設定を切り替えた時。セットアップ完了前の変更は保存のみ。登録後の status が `enabled` でなければ保存せずエラー (承認待ちなら「ログイン項目」を開く案内)。起動時は登録・解除せず、システム設定での変更 (オフ・削除・オン) を設定に取り込む。開発ビルドはセットアップ完了時・起動時の処理をせず、設定画面で切り替えた時だけ登録・解除する | status の意味は SDK の SMAppService.h: 利用者がシステム設定でオフにすると `requiresApproval`、解除済みは `notRegistered`。起動時に status から推測して登録し直すと利用者の選択を上書きするため | tauri-plugin-autostart の macOS 実装は LaunchAgent (plist をアプリ外に置く) か AppleScript (自動化の許可が要る) のみのため使わない |
| Dock | 通常は非表示(Accessory)。設定・セットアップウィンドウ表示中のみ表示(Regular) | |
| 配布 | Developer ID署名 + 公証の .dmg。Mac App Storeは対象外 | サンドボックスではCGEventPost不可 |
| 実行環境の導入 | アプリは軽量に保ち、初回セットアップでuv(同梱)がPython・依存・モデルを導入 | |
| アンインストール | 設定 > ストレージ の「完全にアンインストール」+ `scripts/uninstall.sh`。「実行環境とモデルのみ削除」も提供 | |
| 開発環境 | Nix flakes devShell + Makefile + process-compose | |
| 作らない機能 | キーボードショートカット、押している間だけ録音するモード、文字起こし履歴、入力完了時の効果音、「取り消し」音声での破棄 | 2026-09-30 決定 |

## 識別子・パス

| | 本番 | 開発 |
|---|---|---|
| バンドルID | `com.minimalcorp.mukuchi` | `com.minimalcorp.mukuchi.dev` |
| データ | `~/Library/Application Support/<バンドルID>/` | 同左 (devのID) |

データディレクトリ配下: `settings.json` `uv/` `python/`(UV_PYTHON_INSTALL_DIR) `venv/` `cache/`(UV_CACHE_DIR) `models/`(HF_HOME)。ログは `~/Library/Logs/<バンドルID>/`。アプリ外(`~/.cache` 等)に書き込まない。

アンインストール対象: 上記データディレクトリ、`~/Library/{Caches,Logs,WebKit,HTTPStorages}/<バンドルID>`、`~/Library/Saved Application State/<バンドルID>.savedState`、`~/Library/Preferences/<バンドルID>.plist` (`defaults delete <バンドルID>` で消す。ファイル削除だけでは cfprefsd のキャッシュから書き戻されうる)、ログイン項目、TCC (`tccutil reset All <バンドルID>`。LaunchServices に登録されたアプリが必要なため本体を消す前に行う)、アプリ本体(ゴミ箱へ)。HTTPStorages・Saved Application State は WebKit・AppKit がバンドルIDで作りうるため含める(存在するものだけ消す)。開発版は `tauri dev` の未バンドル実行で WebKit が作る `~/Library/{Caches,WebKit}/mukuchi` も対象。

- ログイン項目: `SMAppService.mainAppService` で登録したもの。ファイルはアプリ外に置かず、システムの Background Task Management (BTM) に記録される(「システム設定 > 一般 > ログイン項目」に表示)。アプリ内のアンインストールでは本体を消す前に `SMAppService.mainApp.unregister` で解除する。`scripts/uninstall.sh` からは API を呼べないため解除せず、残っていればシステム設定から削除するよう表示する。アプリ本体を消した後に BTM の記録が残るか(自動で消えるか)は未検証 (実機でログイン項目を登録して確かめる必要があり、利用者の環境を変えるため未実施)。`sfltool resetbtm` は他のアプリの項目も消すため使わない
- LaunchAgent (`~/Library/LaunchAgents/*.plist`) は作らない

## 同梱物と初回セットアップ (P4)

### .app に同梱するもの (macos-release-engineer が bundle 設定、rust-engineer は下記パスを前提に実装)

| Resources 配下 | 内容 |
|---|---|
| `bin/uv` | uv の単一バイナリ (aarch64-apple-darwin。版は devShell の uv と揃え、sha256 を固定して `scripts/fetch-uv.sh` が取得)。公式リリースは開発元 (Astral) の Developer ID 署名・Hardened Runtime・タイムスタンプ付きで公証済みのため、再署名せずそのまま同梱する |
| `asr-server/` | `pyproject.toml` `uv.lock` `.python-version` `src/` (テスト・キャッシュは除く) |
| `verify.wav` | 検証用音声 (「確認します。」、Kyoko の合成音声、16kHz/mono/s16、約1.1秒)。`scripts/make-verify-wav.sh` で作りリポジトリに置く (`src-tauri/resources/verify.wav`) |
| `THIRD_PARTY_NOTICES`, `licenses/` | ライセンス |

- `bin/uv` と `asr-server/` は `scripts/prepare-bundle-resources.sh` が `src-tauri/bundle-resources/` (gitignore) に用意する。tauri-build は dev でも resources を要求するため `make setup` と `make build*` から呼ぶ
- Rust からは `app.path().resolve("bin/uv", BaseDirectory::Resource)` 等で解決する。本番は `mukuchi.app/Contents/Resources/`、`tauri dev` は `src-tauri/target/debug/` (tauri-build がコピー) を指す

### セットアップ手順 (provisioning)

1. **runtime**: 同梱 uv で Python を `python/` に導入し、`asr-server/` をデータディレクトリへコピーして `uv sync --frozen --no-dev` で `venv/` を作る (環境変数 `UV_PYTHON_INSTALL_DIR` `UV_CACHE_DIR` `UV_PROJECT_ENVIRONMENT` をデータディレクトリ配下に向ける。`UV_NO_CONFIG=1` でユーザーのuv設定を読まない)
2. **model**: 配布モデルを Hugging Face から `models/` (HF_HOME) に取得。リポジトリIDと revision は Rust の定数で固定 (配布用リポジトリが決まるまで `neosophie/Qwen3-ASR-1.7B-JA` の固定revision)。進捗・一時停止・再開(部分ファイルからの再開)は Rust が HTTP で直接取得して実現する
3. **verify**: ASRサーバーを起動し `/health` と、同梱の短い無音ではない検証用音声 (TTSで作成、`Resources/verify.wav`) で `/transcribe` が成功することを確認

導入済みの判定は `<データ>/provisioned.json` (runtime/model の版と完了時刻) で行う。版が変わった場合は該当ステップのみやり直す。

### 本番の ASR サーバー起動

`<データ>/venv/bin/python -m mukuchi_asr --port <空きポート> --model <models内のパス> --exit-on-stdin-eof` を stdin をパイプにして起動 (環境変数 `HF_HOME` `HF_HUB_OFFLINE=1`)。stdout/stderr は `~/Library/Logs/<バンドルID>/asr-server.log` へ。異常終了時は3回まで自動再起動。

## インターフェース

変更する場合は先にここを更新し、関係するsubagentに周知する。

### ASRサーバー HTTP API (asr-server ↔ Rust)

- 待受: `127.0.0.1:<port>`。本番はRustが空きポートを選び `--port` で渡し、`--exit-on-stdin-eof` 付きで起動する。開発は `18765` 固定でprocess-composeが起動し、アプリは環境変数 `MUKUCHI_ASR_URL` があればそれに接続する(自分では起動しない)
- `GET /health` → `200 {"status":"ok","model":"<id>"}`。モデル読み込み完了まで応答しない
- `POST /transcribe` — body: 16kHz/mono/16bit PCMのWAV (`Content-Type: audio/wav`)。query: `language` (既定 `Japanese`)、`context` (語彙ヒント、任意) → `200 {"text":"...","elapsed_ms":123}`
  - `elapsed_ms`: サーバーがbodyを受信し終えてから応答するまでの時間 (WAVデコード + 推論待ち + 推論)。ネットワーク転送は含まない
  - エラー: 不正なWAV/形式違い → `400`、body が 5MiB (約120秒分+余裕) を超える → `413`
- 開発用 (デバッグビルドのみ): `MUKUCHI_DEV_AUDIO_FILE=<wav>` でマイクの代わりにWAVを実時間で流す (その後は無音)。`MUKUCHI_DEV_AUTO_LISTEN=1` でASR準備完了後に自動でONにする (セットアップ画面は開かない)。`MUKUCHI_DEV_TARGET_BUNDLE=<bundle id>` でそのアプリが前面の時だけ入力する (自動テストで他のアプリに入力しないため)。`MUKUCHI_DEV_NO_PARTIAL=1` で途中表示を送らない (遅延の比較用)。`MUKUCHI_ASR_URL` もデバッグビルドのみ有効で、ループバックの http のみ受け付ける
- 推論は直列実行 (MLXはスレッド束縛のため、読み込み・ウォームアップ・全推論を専用の1スレッドで行う)。無音由来の定型ハルシネーション除外はサーバー側で行う
- リアルタイムプレビューも同じ `/transcribe` を使う(専用APIは設けない)

### Tauri commands / events (Rust ↔ フロントエンド)

型はRust側を正とし、`src/lib/ipc.ts` にTypeScript型を手書きで同期する。名前はRustがsnake_case、JSONのフィールドはcamelCase (`#[serde(rename_all = "camelCase")]`)。ウィンドウのlabelは `panel` / `settings` / `setup`。

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
  stableLength: number;  // 先頭から確定扱いの長さ (UTF-16 コード単位 = JS の length/slice と同じ)。以降はプレビューで薄く表示
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
  vocabulary: string[];                   // ASR の context に空白区切りで渡す
  excludedApps: { bundleId: string; name: string }[];
  panelPosition: { x: number; y: number; displayId: string } | null; // null=既定位置。x,y はpanelウィンドウの下端中央の、ディスプレイ左下からの位置 (整数pt、y上向き)。displayId は CGDirectDisplayID (ピルの中心があるディスプレイ)
  setupCompleted: boolean;
};
type KeyCombo = { key: "enter" | "tab" | "escape" | "backspace"; modifiers: ("cmd" | "shift" | "option" | "ctrl")[] };

type Permissions = {
  microphone: "granted" | "denied" | "not_determined";
  accessibility: boolean;
};

type ProvisioningStatus = {
  stage: "idle" | "runtime" | "model" | "verify" | "done" | "paused" | "error";
  items: { id: "runtime" | "model" | "verify"; state: "pending" | "active" | "done"; bytesDone: number; bytesTotal: number | null }[];
  bytesDone: number;
  bytesTotal: number | null;
  etaSeconds: number | null;
  error: string | null;
};

type StorageUsage = { runtimeBytes: number; modelBytes: number; otherBytes: number };
type AudioDevice = { id: string; name: string; isDefault: boolean };
type AppInfo = { version: string; build: string };
type SettingsCategory = "general" | "voice" | "commands" | "recognition" | "permissions" | "storage" | "about";
```

#### commands

エラー時は表示用メッセージ(日本語の文字列)で reject する。未実装のcommandは `not_implemented:` で始まる文字列を返す。

| command | 引数 → 戻り値 | 用途 |
|---|---|---|
| `get_status` | → `AppStatus` | 初期表示 |
| `set_listening` | `{ on: boolean }` → `()` | パネル・メニューのON/OFF |
| `get_settings` / `update_settings` | → `Settings` / `{ patch: Partial<Settings> }` → `Settings` | 設定の読み書き(即時保存・即時反映。感度・無音時間は録音中も約0.5秒以内に反映、マイクの変更は録音をやり直す) |
| `list_input_devices` | → `AudioDevice[]` | マイク選択 |
| `get_permissions` | → `Permissions` | 権限表示(setupでは1秒ごとに再取得) |
| `request_microphone` | → `Permissions` | マイク許可ダイアログを出す |
| `open_system_settings` | `{ pane: "microphone" \| "accessibility" \| "login_items" }` → `()` | システム設定を開く。`login_items` はログイン項目 (`SMAppService.openSystemSettingsLoginItems`。launchAtLogin を ON にできなかった時の案内用) |
| `restart_asr` | → `()` | エラーからの復旧 |
| `get_provisioning_status` | → `ProvisioningStatus` | |
| `start_provisioning` / `pause_provisioning` | → `()` | ダウンロード開始・再開 / 一時停止 |
| `get_storage_usage` | → `StorageUsage` | |
| `delete_runtime_and_model` | → `()` | 実行環境とモデルのみ削除 |
| `get_uninstall_targets` | → `{ path: string; bytes: number }[]` | 確認ダイアログの一覧 |
| `uninstall` | → `()` | 完全にアンインストール(完了後にアプリ終了) |
| `list_running_apps` | → `{ bundleId: string; name: string }[]` | 入力しないアプリの追加候補 |
| `open_logs_folder` | → `()` | Finderで開く |
| `get_app_info` | → `AppInfo` | |
| `open_settings` | `{ category?: SettingsCategory }` → `()` | 設定ウィンドウを開く(開いていれば前面に出し `settings-navigate` を送る)。エラー復旧から該当カテゴリを開く |
| `set_panel_size` | `{ width: number; height: number }` → `()` | panelの描画内容(影の余白込み)の大きさ。Rustはpanelウィンドウをこの大きさにし、下端中央を基準位置に保つ(透明部分がクリックを奪わないようにするため) |
| `complete_setup` | → `()` | セットアップ完了。launchAtLogin をログイン項目に反映し (本番ビルドのみ。登録できなければ launchAtLogin を false にして完了する)、setupウィンドウを閉じる |
| `open_setup` | → `()` | セットアップウィンドウを開く(エラー `start_setup` の復旧・実行環境の再導入) |

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
| `permissions-changed` | `Permissions` | 権限の変化を検知した時 |
| `input-devices-changed` | `AudioDevice[]` | マイクの接続・取り外し・既定の変更を検知した時 (2秒ごとのポーリング。settings/setup を開いている間か ON の間のみ) |
| `provisioning-progress` | `ProvisioningStatus` | 約4Hz |
