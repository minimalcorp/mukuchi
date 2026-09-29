#!/usr/bin/env bash
# 全実装のベンチマークを順に実行し、<results_dir>/report.md を生成する。
# 使い方: scripts/run_all.sh [audio_dir (既定: data/audio)] [results_dir (既定: results)]
# メモリ比較のため各実装は別プロセスで /usr/bin/time -l 経由で起動する。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

MODEL_ID="neosophie/Qwen3-ASR-1.7B-JA"
AUDIO_DIR="$(cd "${1:-data/audio}" && pwd)"
export RESULTS_DIR="$(mkdir -p "${2:-results}" && cd "${2:-results}" && pwd)"

# Rust実装はローカルディレクトリを要求するため、HFキャッシュのスナップショットを解決する。
# (tsunagiのwhisper-serverが ~/.tsunagi/whisper/cache にダウンロード済みならそれを使う)
export HF_HOME="${HF_HOME:-$HOME/.tsunagi/whisper/cache}"
MODEL_DIR="$(uvx --from huggingface_hub hf download "$MODEL_ID" --quiet)"
echo "model: $MODEL_DIR"

run() {
  local label="$1"; shift
  echo "=== $label"
  /usr/bin/time -l "$@" 2> >(tee "$RESULTS_DIR/$label.time.txt" >&2)
}

# uv run は子プロセスでPythonを起動し計測対象が uv 自体になるため、スクリプト用環境のPythonを直接実行する。
uv sync --script scripts/bench_python.py --quiet
PY="$(uv python find --script scripts/bench_python.py)"

run python-fp16 "$PY" scripts/bench_python.py --model "$MODEL_DIR" --label python-fp16 --audio-dir "$AUDIO_DIR"
run python-8bit "$PY" scripts/bench_python.py --model "$MODEL_DIR" --label python-8bit --quantize 8 --audio-dir "$AUDIO_DIR"
run rust-candle rust/target/release/candle-bench "$MODEL_DIR" "$AUDIO_DIR" rust-candle
run rust-mlx rust/target/release/mlx-bench "$MODEL_DIR" "$AUDIO_DIR" rust-mlx

uv run scripts/compare.py --baseline python-fp16 > "$RESULTS_DIR/report.md"
echo "-> $RESULTS_DIR/report.md"
