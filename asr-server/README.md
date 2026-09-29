# asr-server

mukuchiのASRサーバー。Qwen3-ASR (`mlx-qwen3-asr`) をMLXで動かし、`127.0.0.1` でHTTP待受する。
HTTP APIは [docs/architecture.md](../docs/architecture.md) の「ASRサーバー HTTP API」を正とする。

## 実行

```bash
uv sync --project asr-server
HF_HOME=<モデル置き場> uv run --project asr-server mukuchi-asr --port 18765 --model neosophie/Qwen3-ASR-1.7B-JA
```

| 引数 | 既定 | |
|---|---|---|
| `--port` | `18765` | 待受ポート (ホストは `127.0.0.1` 固定) |
| `--model` | `neosophie/Qwen3-ASR-1.7B-JA` | HFリポジトリID or ローカルパス。未取得ならHF_HOME配下へダウンロード |
| `--exit-on-stdin-eof` | off | stdinがEOFになったら即終了する。親(Rust)がパイプで起動し、親の終了に追従させるため |

モデル読み込みとウォームアップが終わってから待受を始めるため、`/health` が応答した時点で利用可能。ログはstdout。

```bash
curl -s -H 'Content-Type: audio/wav' --data-binary @sample.wav 'http://127.0.0.1:18765/transcribe?context=Rust%20Tauri'
```

## 開発

```bash
uv run --project asr-server ruff check asr-server
uv run --project asr-server pytest asr-server
```
