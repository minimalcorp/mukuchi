# asr-server

mukuchiのASRサーバー。Qwen3-ASR (`mlx-qwen3-asr`) をMLXで動かし、`127.0.0.1` でHTTP待受する。
HTTP APIは [docs/architecture.md](../../../docs/architecture.md) の「ASRサーバー HTTP API」を正とする。

## 実行

コマンドは `apps/desktop` で実行する (開発時は `make up` が process-compose から同じように起動する)。

```bash
uv sync --project asr-server
HF_HOME=<モデル置き場> uv run --project asr-server mukuchi-asr --port 18765 --model minimalcorp/Qwen3-ASR-1.7B-JA-MLX-8bit
```

| 引数 | 既定 | |
|---|---|---|
| `--port` | `18765` | 待受ポート (ホストは `127.0.0.1` 固定) |
| `--model` | `minimalcorp/Qwen3-ASR-1.7B-JA-MLX-8bit` | HFリポジトリID or ローカルパス。リポジトリIDは未取得ならHF_HOME配下へ最新版をダウンロード (版は固定できない)。本番・`make up` は版を固定したスナップショットのディレクトリ (`<HF_HOME>/hub/models--<org>--<name>/snapshots/<commit>`) を渡す。元の bf16 版は `neosophie/Qwen3-ASR-1.7B-JA` |
| `--exit-on-stdin-eof` | off | stdinがEOFになったら即終了する。親(Rust)がパイプで起動し、親の終了に追従させるため |

モデル読み込みとウォームアップが終わってから待受を始めるため、`/health` が応答した時点で利用可能。ログはstdout。

```bash
curl -s -H 'Content-Type: audio/wav' --data-binary @sample.wav 'http://127.0.0.1:18765/transcribe?context=Rust%20Tauri'
```

## 配布用モデルの変換

```bash
HF_HOME=<モデル置き場> uv run --project asr-server mukuchi-asr-convert --model neosophie/Qwen3-ASR-1.7B-JA --bits 8 --out <出力先>
```

MLX形式の量子化済みチェックポイントを作る(サーバー実行時には使わない)。`--encoder-bits 16` で音声エンコーダを非量子化、`--bits 4 --encoder-bits 8` で4bitデコーダ。
`--bits 5` は全層5bit (mlx-qwen3-asr 0.4.4 の読み込みが層ごとの5bitを判定できないため、5bit はデコーダが5bitの時だけ。エンコーダだけ5bitは不可)。
出力先はそのまま `--model` に渡せる。採用した設定と評価は [spikes/asr-bench/MODEL_DECISION.md](../../../spikes/asr-bench/MODEL_DECISION.md)、話す言語ごとのモデルは [MODEL_DECISION_I18N.md](../../../spikes/asr-bench/MODEL_DECISION_I18N.md)。

## 開発

```bash
uv run --project asr-server ruff check asr-server
uv run --project asr-server pytest asr-server
```
