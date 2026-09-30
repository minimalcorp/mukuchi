# 実装計画 (v0.1)

決定事項・インターフェースは [docs/architecture.md](../architecture.md) が正。UIの正は Claude Design handoff (`docs/design/handoff/project/mukuchi UI Proposal.dc.html`。社内デザインシステムを含むためgit管理外。各自 `~/Downloads/mukuchi.zip` 等から配置)。

## 1. 画面構成 (frontend-engineer)

| ウィンドウ(label) | サイズ | 内容 (デザインのセクション) |
|---|---|---|
| `panel` | ピル 36px高 (OFF: 文言幅 / ON: 240px) → 発話時 440px幅に展開 | 03 常時表示パネル。ON/OFFボタン、入力レベルメーター(しきい値の縦線、超えると青)、プレビュー(確定部分は濃く・未確定の末尾は薄いグレー、3行超で上に送る)、状態表示(認識中 / 確定しています… / 「<アプリ名> に入力しました」 / 音声コマンド「Enter を送信しました」 / このアプリには入力しません / エラー)。入力完了1.2秒後にピルへ戻る。展開・収縮180ms、文字追加はアニメーションしない |
| `setup` | 560×440 | 04 初回セットアップ 5ステップ: ようこそ → 権限(1秒ごと再取得、2つとも許可で次へ) → 実行環境とモデルのダウンロード(全体と項目別の進捗・残り時間・一時停止・失敗時の再試行) → 動作テスト(テキスト欄にフォーカスし、パネルでONにして話すとその欄に実際に入力される。音声コマンドはバッジ表示) → 完了(ログイン時に起動のスイッチ) |
| `settings` | 760×560、サイドバー200px | 05 設定: 一般(ログイン時に起動) / 音声入力(マイク選択、入力レベル、発話検出の感度0-100、話し終わりの無音0.3-3.0秒、**入力しないアプリ**) / 音声コマンド(ON/OFF、言い方→送るキーの表、追加・編集・削除) / 認識(モデル状態、語彙ヒント) / 権限(状態、未許可時の案内とシステム設定を開く、未許可時はサイドバーに黄色の点) / ストレージ(使用量の内訳、実行環境とモデルのみ削除、完全にアンインストールの確認ダイアログ) / このアプリについて(バージョン、ライセンス、ログをFinderで開く) |
| メニューバー | macOS標準メニュー (Rustが構築) | 02: 状態の行(聞いています / オフ・モデル読み込み済み / モデルを読み込んでいます… n%)、音声入力をオン/オフ、設定を開く… ⌘,、mukuchi を終了 ⌘Q。エラー時は最上部に原因の行と復旧項目(06) |

デザインとの差分(決定済み):
- ショートカットの設定・表示は作らない
- 「アップデートを確認」はv0.1では表示しない(自動アップデートの仕組みを入れる時に追加)
- アンインストールの一覧のパスは architecture.md の実パス (`get_uninstall_targets` の結果) を表示する
- セットアップの容量表示は実測値を使う(デザインの 3.6GB は仮)
- 任意提案Bの「取り消し」は作らない

実装方針:
- 1つのViteアプリで、ウィンドウのlabelごとに画面を出し分ける (`getCurrentWindow().label`)
- Tailwind + shadcn/ui をMinimal Portalのトークン(色・角丸・影・モーション)で上書きする。押下は0.5px沈み込み、モーション120ms (DSに従う)
- 状態はすべて Rust の events を購読して反映する。`src/lib/ipc.ts` に型付きラッパーを集約
- Rust側が未実装でも画面を作れるよう、`@tauri-apps/api/mocks` の `mockIPC` を使ったモックと、Playwright で各画面を確認できる状態を用意する

## 2. Rust の機能 (rust-engineer)

| モジュール | 内容 |
|---|---|
| `state` | アプリ状態 (`Phase`) の一元管理と `status-changed` の発行。ON/OFF、エラー時の自動OFF |
| `audio` | cpal で録音、指定デバイス(切断検知で `microphone_missing`)、16kHz mono へ変換、RMS から `audio-level` を約20Hzで発行 |
| `vad` | Silero VAD (ort) をtraitの背後に。感度0-100 → VADしきい値と音量の下限(無音で「はい、」等が出る問題の対策)。話し始めの前300msを含める、無音 `silenceMs` で発話終了、極端に短い区間は捨てる |
| `pipeline` | 発話の開始・途中・終了を管理。発話中は約0.8秒ごとに、ASRが空いていれば途中までの音声を送り `utterance-partial` を発行(前回との共通部分を `stableLength` に)。終了時は最終結果を優先して送る。古い途中結果は捨てる |
| `asr` | HTTPクライアント (`/health` `/transcribe`、語彙ヒントを `context` に)。プロセス管理: 本番は空きポートで `uv run` 起動・`/health` 待ち・異常終了時は3回まで自動再起動・失敗で `asr_stopped`。開発は `MUKUCHI_ASR_URL` に接続のみ |
| `insert` | 単一キューで直列実行。音声コマンド判定(正規化後に完全一致) → キー送信 / それ以外 → クリップボード退避 → 設定 → ⌘V → 復元。前面アプリ(名前・bundle id)を取得し、入力しないアプリなら入力しない。アクセシビリティ未許可なら `accessibility_denied` でOFF |
| `permissions` | マイク (AVCaptureDevice) とアクセシビリティ (AXIsProcessTrusted) の状態取得、許可要求、システム設定を開く、変化の検知 |
| `tray` | NSMenu の構築と状態に応じた更新、状態別アイコン(テンプレート画像 + エラー時の赤点付き画像) |
| `windows` | panel を `tauri-nspanel` でフォーカスを奪わないパネルに(全Spaceに表示、ドラッグ移動・位置保存、前面ウィンドウのあるディスプレイの下中央)。settings/setup の表示と Dock 表示の切り替え (ActivationPolicy) |
| `settings` | `settings.json` の読み書き・既定値・変更の即時反映と `settings-changed` |
| `provisioning` | 同梱uvで Python・依存(asr-serverの `uv.lock`)・モデルをデータディレクトリに導入。進捗・残り時間・一時停止/再開・失敗時の再開。実行環境とモデルの削除、使用量計算 |
| `uninstall` | 対象一覧の計算、削除、ログイン項目解除、`tccutil reset`、アプリ本体をゴミ箱へ移動して終了 |
| `autostart` | ログイン時に起動 (tauri-plugin-autostart。macOSの方式は実装時に確認) |

## 3. 進め方

UI と Rust は architecture.md のインターフェースを境界に並行して進める。各フェーズの最後に code-reviewer のレビューを通してからcommitする。

| フェーズ | 内容 | 担当 | 完了条件 |
|---|---|---|---|
| P1 中核の流れ | audio / vad / pipeline(最終結果のみ) / asr(開発用の接続) / insert / state / 最小限のtray(ON/OFF・終了)。音声コマンド・入力しないアプリを含む | rust-engineer | `make up` 後、メニューバーからONにして話すと、前面のアプリ(テキストエディット等)に発話ごとに入力される。「確定」でEnterが送られる。VAD・コマンド判定・入力キューの単体テストが通る |
| P1' UI基盤と全画面 (並行) | デザイントークン・フォント・shadcn/ui の導入、panel / setup / settings の全画面をモックIPCで実装 | frontend-engineer | 全画面・全状態がモックで表示でき、Playwright で各画面を確認できる。`npm run build` が通る |
| P1'' モデル | 配布用の8bit日本語モデルの用意(既存の変換済みモデルが mlx-qwen3-asr で読めるか、または自前で量子化して置くか)と、fp16との精度比較 | asr-server-engineer | spikes/asr-bench で fp16 と同等の精度を確認し、採用モデルを決める |
| P2 パネルとプレビュー | panel の NSPanel 化、audio-level、リアルタイムプレビュー、状態遷移を実データで接続。tray の状態表示・エラー表示 | rust-engineer + frontend-engineer | 話している途中の文字がパネルに出て、話し終わると入力される。エラー(アクセシビリティ未許可、ASR停止、マイク切断)が表示され復旧できる |
| P3 設定 | settings の全カテゴリを実データで接続(マイク選択・感度・無音時間・音声コマンド・語彙ヒント・入力しないアプリ・権限・ログイン時に起動) | 両者 | 設定変更が即座に動作へ反映され、再起動後も保持される |
| P4 セットアップと配布準備 | provisioning(uv同梱・Python・依存・モデル)、setup の実データ接続、ストレージ・削除・アンインストール、`scripts/uninstall.sh` | rust-engineer + frontend-engineer + macos-release-engineer | 何も入っていない状態から、セットアップ → 動作テスト → 常駐まで通る。アンインストールで対象がすべて消える |
| P5 リリース | 署名・公証 (`make build`)、Info.plist の権限説明文、entitlements、Hardened Runtime 下での動作確認 | macos-release-engineer | 公証済み .dmg を別ユーザー環境で入れて、セットアップから使用まで通る |

## 4. 未確定・要検証

- 8bit日本語モデルの入手方法と精度 (P1'')
- `tauri-nspanel` の Tauri 2.x 最新版との互換性と、パネル上のボタンをクリックしても前面アプリのフォーカスが移らないこと (P2 の最初に検証)
- モデル読み込みの進捗(%)は mlx-qwen3-asr から取得できない可能性がある。取れない場合は不定の表示にする
- ログイン時に起動の実装方式(SMAppService か LaunchAgent か)と、アンインストール時の解除方法
- リアルタイムプレビュー時の GPU 負荷と、最終結果までの遅延への影響 (P2 で計測)
