#!/usr/bin/env bash
# 話す言語 (ja / en) ごとの推奨モデルを決めるための比較 (MODEL_DECISION_I18N.md)。
# 全モデル × {ja: data/tts, en: data/tts-en, en: data/libri} を python-mlx で計測し、<results_dir>/<set>/report.md を作る。
# 使い方: scripts/run_i18n.sh [results_dir (既定: results-i18n)] [set ...(既定: ja en-tts en-libri)]
# 事前に: scripts/make_tts.sh、scripts/make_tts.sh --lang en、scripts/prep_librispeech.sh、
#         models/base-* の変換 (MODEL_DECISION_I18N.md の再現手順)、ja-8bit の取得 (make setup で dev データに入る)。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

OUT="$(mkdir -p "${1:-results-i18n}" && cd "${1:-results-i18n}" && pwd)"; shift || true
SETS=("${@:-ja en-tts en-libri}")
# shellcheck disable=SC2206
SETS=(${SETS[*]})
export HF_HUB_OFFLINE=1

JA8="${MUKUCHI_JA8_SNAPSHOT:-$HOME/Library/Application Support/com.minimalcorp.mukuchi.dev/models/hub/models--minimalcorp--Qwen3-ASR-1.7B-JA-MLX-8bit/snapshots/698eff963b084561b12a045c95bc4a208898337f}"
MODELS=("ja-8bit=$JA8" "base-1.7b-8bit=models/base-1.7b-8bit" "base-1.7b-5bit=models/base-1.7b-5bit"
        "base-0.6b-8bit=models/base-0.6b-8bit")

uv sync --script scripts/bench_python.py --quiet
PY="$(uv python find --script scripts/bench_python.py)"

for set in "${SETS[@]}"; do
  case "$set" in
    ja) AUDIO=data/tts; LANGUAGE=Japanese; CORPUS=corpus.tsv; METRIC=cer ;;
    en-tts) AUDIO=data/tts-en; LANGUAGE=English; CORPUS=corpus.en.tsv; METRIC=wer ;;
    en-libri) AUDIO=data/libri; LANGUAGE=English; CORPUS=data/libri/corpus.tsv; METRIC=wer ;;
    *) echo "未対応のセット: $set" >&2; exit 1 ;;
  esac
  export RESULTS_DIR="$OUT/$set"; mkdir -p "$RESULTS_DIR"
  for m in "${MODELS[@]}"; do
    label="${m%%=*}"; model="${m#*=}"
    echo "=== $set / $label"
    # 他の計測と並行させない (レイテンシが揺れる)。peak memory は /usr/bin/time -l で取る
    /usr/bin/time -l "$PY" scripts/bench_python.py --label "$label" --model "$model" \
      --audio-dir "$AUDIO" --language "$LANGUAGE" > "$RESULTS_DIR/$label.log" \
      2> >(tee "$RESULTS_DIR/$label.time.txt" >&2)
  done
  uv run scripts/compare.py --baseline base-1.7b-8bit --corpus "$CORPUS" --metric "$METRIC" > "$RESULTS_DIR/report.md"
  echo "-> $RESULTS_DIR/report.md"
done
