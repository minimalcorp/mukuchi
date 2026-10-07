#!/usr/bin/env bash
# LibriSpeech test-clean (CC BY 4.0, https://www.openslr.org/12) から N 発話を選び、
# <out_dir>/<utt>.wav (16kHz/mono/16bit) と <out_dir>/corpus.tsv (正解、id<TAB>text) を作る。
# 英語の実音声 (読み上げ) での比較用。選び方は全2620発話をid順に並べて等間隔に取る (話者・章が散らばり、再現できる)。
# 使い方: scripts/prep_librispeech.sh [out_dir (既定: data/libri)] [N (既定: 100)]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
OUT="${1:-data/libri}"; N="${2:-100}"
TAR=data/test-clean.tar.gz
# 346MB。取得済みなら再取得しない
[[ -f "$TAR" ]] || curl -fSL -o "$TAR" https://www.openslr.org/resources/12/test-clean.tar.gz
[[ -d data/LibriSpeech/test-clean ]] || tar -xzf "$TAR" -C data
mkdir -p "$OUT"
ALL="$(cat data/LibriSpeech/test-clean/*/*/*.trans.txt | sort)"
TOTAL="$(wc -l <<<"$ALL")"
STEP=$(( TOTAL / N ))
printf 'id\ttext\n' >"$OUT/corpus.tsv"
awk -v step="$STEP" -v n="$N" '(NR - 1) % step == 0 && c < n { c++; print }' <<<"$ALL" | while read -r utt text; do
  spk="${utt%%-*}"; rest="${utt#*-}"; chap="${rest%%-*}"
  # macOS の afconvert は FLAC を読める (追加の依存なし)
  afconvert -f WAVE -d LEI16@16000 -c 1 "data/LibriSpeech/test-clean/$spk/$chap/$utt.flac" "$OUT/$utt.wav"
  printf '%s\t%s\n' "$utt" "$text" >>"$OUT/corpus.tsv"
done
echo "$(( $(wc -l <"$OUT/corpus.tsv") - 1 )) 発話 -> $OUT"
