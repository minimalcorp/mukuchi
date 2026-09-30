#!/usr/bin/env bash
# corpus.tsv を macOS の say で複数話者分読み上げ、<out_dir>/<id>.<voice>.wav (16kHz/mono/16bit) を作る。
# 自分の声の録音(data/audio)がない場合の精度比較用。話者を変えてサンプル数を稼ぐ。
# 使い方: scripts/make_tts.sh [out_dir (既定: data/tts)] [voice ...]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
OUT="${1:-data/tts}"; shift || true
VOICES=("${@:-Kyoko Eddy Flo Reed Sandy}")
# shellcheck disable=SC2206
VOICES=(${VOICES[*]})
mkdir -p "$OUT"
tail -n +2 corpus.tsv | while IFS=$'\t' read -r id text; do
  for v in "${VOICES[@]}"; do
    say -v "$v" -o "$OUT/$id.$(echo "$v" | tr 'A-Z' 'a-z').wav" --file-format=WAVE --data-format=LEI16@16000 "$text"
  done
done
ls "$OUT" | wc -l
