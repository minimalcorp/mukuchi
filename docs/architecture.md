# アーキテクチャ・決定事項

## 全体構成

```
mukuchi.app (1プロセス)
 ├─ WebView (React: 設定・セットアップ・オーバーレイ)
 │     ↕ Tauri invoke / event
 └─ Rust (録音 cpal → VAD Silero/ort → 発話切り出し → ASRクライアント → 入力)
       ↕ HTTP 127.0.0.1
asr-server (別プロセス / Python + mlx-qwen3-asr)
```

## 決定事項

| 項目 | 決定 | 理由・備考 |
|---|---|---|
| 対象OS | macOS (Apple Silicon, aarch64のみ) | MLXがApple Silicon専用 |
| フレームワーク | Tauri v2 + Rust | 押下/解放の取得、入力送信、常駐の軽さ |
| フロントエンド | React + TypeScript + Vite。UIはshadcn/ui + lucide-react (tsunagiに準拠) | |
| 録音 | Rust (cpal) | WebView経由のgetUserMediaは権限ダイアログ二重表示等の既知問題あり |
| VAD | Silero VAD (`ort`、arm64は静的リンク)。差し替え可能なtraitの背後に置く | 代替: earshot |
| ASR | Python + MLX (`mlx-qwen3-asr`)、既定モデル `neosophie/Qwen3-ASR-1.7B-JA` | Rust実装(candle/MLX)は約3倍遅い (spikes/asr-bench)。ASRクライアントは差し替え可能に |
| 入力方式 | クリップボード + ⌘V、元のクリップボードを復元 | IMEの影響を受けない |
| 入力単位 | ONの間、発話(VAD区間)ごとに逐次入力。入力は単一キューで直列化 | 必須要件 |
| 音声コマンド | 「語→キー」対応表(既定: 確定/エンター→Enter)。発話全体が正規化後に完全一致した時のみ。機能ごとON/OFF可 | 表記揺れは別名登録で吸収 |
| 配布 | Developer ID署名 + 公証の .dmg。Mac App Storeは対象外 | サンドボックスではCGEventPost不可 |
| 実行環境の導入 | アプリは軽量に保ち、初回起動時のセットアップでuv(同梱)がPython・依存・モデルを導入 | |
| アンインストール | アプリ内「完全にアンインストール」+ `scripts/uninstall.sh`。「環境のみ削除」も提供 | |
| 開発環境 | Nix flakes devShell + Makefile + process-compose | |

## 識別子・パス

| | 本番 | 開発 |
|---|---|---|
| バンドルID | `com.minimalcorp.mukuchi` | `com.minimalcorp.mukuchi.dev` |
| データ | `~/Library/Application Support/<バンドルID>/` | 同左 (devのID) |

データディレクトリ配下: `uv/` `python/`(UV_PYTHON_INSTALL_DIR) `venv/` `cache/`(UV_CACHE_DIR) `models/`(HF_HOME) `logs/`。アプリ外(`~/.cache` 等)に書き込まない。

アンインストール対象: 上記データディレクトリ、`~/Library/{Caches,Logs,WebKit}/<バンドルID>`、`~/Library/Preferences/<バンドルID>.plist`、ログイン項目、TCC (`tccutil reset All <バンドルID>`)、アプリ本体。

## インターフェース

変更する場合は先にここを更新し、関係するsubagentに周知する。

### ASRサーバー HTTP API (asr-server ↔ Rust)

- 待受: `127.0.0.1:<port>`。本番はRustが空きポートを選び `--port` で渡す。開発は `18765` 固定 (tsunagiの8765と衝突させない)
- `GET /health` → `200 {"status":"ok","model":"<id>"}`。モデル読み込み完了まで応答しない
- `POST /transcribe` — body: 16kHz/mono/16bit PCMのWAV (`Content-Type: audio/wav`)。query: `language` (既定 `Japanese`)、`context` (語彙ヒント、任意) → `200 {"text":"...","elapsed_ms":123}`
  - `elapsed_ms`: サーバーがbodyを受信し終えてから応答するまでの時間 (WAVデコード + 推論待ち + 推論)。ネットワーク転送は含まない
  - エラー: 不正なWAV/形式違い → `400`、body が 5MiB (約120秒分+余裕) を超える → `413`
- 推論は直列実行 (MLXはスレッド束縛のため、読み込み・ウォームアップ・全推論を専用の1スレッドで行う)。無音由来の定型ハルシネーション除外はサーバー側で行う

### Tauri commands / events (Rust ↔ フロントエンド)

実装時に rust-engineer が定義し、ここへ一覧を追記する。型はRust側を正とし、TypeScript型を生成または手書きで同期する。
