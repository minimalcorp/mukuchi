#!/usr/bin/env bash
# コーパスを macOS の say で複数話者分読み上げ、<out_dir>/<id>.<voice>.wav (16kHz/mono/16bit) を作る。
# 自分の声の録音(data/audio)がない場合の精度比較用。話者を変えてサンプル数を稼ぐ。
# 使い方: scripts/make_tts.sh [--lang ja|en] [out_dir (既定: data/tts、en は data/tts-en)] [voice ...]
#   ja: corpus.tsv を Kyoko Eddy Flo Reed Sandy で読む
#   en: corpus.en.tsv を Samantha(US) Daniel(GB) Karen(AU) Moira(IE) Rishi(IN) で読む
# 英語で Eddy 等の多言語の声を名前だけで指定すると、システムの言語 (日本語) 版が選ばれるため使わない。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
LANG_ID=ja
if [[ "${1:-}" == "--lang" ]]; then LANG_ID="$2"; shift 2; fi
case "$LANG_ID" in
  ja) CORPUS=corpus.tsv; DEF_OUT=data/tts; DEF_VOICES="Kyoko Eddy Flo Reed Sandy" ;;
  en) CORPUS=corpus.en.tsv; DEF_OUT=data/tts-en; DEF_VOICES="Samantha Daniel Karen Moira Rishi" ;;
  *) echo "未対応の言語: $LANG_ID" >&2; exit 1 ;;
esac
OUT="${1:-$DEF_OUT}"; shift || true
VOICES=("${@:-$DEF_VOICES}")
# shellcheck disable=SC2206
VOICES=(${VOICES[*]})
mkdir -p "$OUT"
tail -n +2 "$CORPUS" | while IFS=$'\t' read -r id text; do
  for v in "${VOICES[@]}"; do
    say -v "$v" -o "$OUT/$id.$(echo "$v" | tr 'A-Z' 'a-z').wav" --file-format=WAVE --data-format=LEI16@16000 "$text"
  done
done
ls "$OUT" | wc -l
