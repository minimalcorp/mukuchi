#!/usr/bin/env bash
# 配布用モデル候補(量子化済みチェックポイント)を python-mlx で比較する (P1'')。
# 使い方: scripts/run_models.sh [audio_dir (既定: data/tts)] [results_dir (既定: results-models)]
# 事前に asr-server の mukuchi-asr-convert で models/ja-* を作り、mlx-audio版を models/hf に取得しておく (MODEL_DECISION.md)。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

AUDIO_DIR="$(cd "${1:-data/tts}" && pwd)"
export RESULTS_DIR="$(mkdir -p "${2:-results-models}" && cd "${2:-results-models}" && pwd)"
export HF_HUB_OFFLINE=1

snapshot() { HF_HOME="$1" uvx --from huggingface_hub hf download "$2" --quiet 2>/dev/null; }
BASE="$(snapshot "${HF_HOME:-$HOME/Library/Application Support/com.minimalcorp.mukuchi.dev/models}" neosophie/Qwen3-ASR-1.7B-JA)"
MLXAUDIO="$(snapshot "$PWD/models/hf" ultragtx/Qwen3-ASR-1.7B-JA-8bit)"

uv sync --script scripts/bench_python.py --quiet
PY="$(uv python find --script scripts/bench_python.py)"

run() {
  local label="$1"; shift
  echo "=== $label"
  /usr/bin/time -l "$PY" scripts/bench_python.py --label "$label" --audio-dir "$AUDIO_DIR" "$@" \
    2> >(tee "$RESULTS_DIR/$label.time.txt" >&2)
}

run fp16             --model "$BASE"
run runtime-8bit     --model "$BASE" --quantize 8
run ja-8bit          --model models/ja-8bit
run ja-8bit-enc16    --model models/ja-8bit-enc16
run ja-4bit-enc8     --model models/ja-4bit-enc8
run mlxaudio-8bit    --model "$MLXAUDIO"

uv run scripts/compare.py --baseline fp16 > "$RESULTS_DIR/report.md"
echo "-> $RESULTS_DIR/report.md"
