#!/usr/bin/env bash
# 初回セットアップの verify で使う検証用音声 (「確認します。」の合成音声、16kHz/mono/s16) を作る。
# 使い方: make-verify-wav.sh <出力先.wav> [文章]
# 生成物はリポジトリに入れない。scripts/prepare-bundle-resources.sh が .build-cache/ に一度だけ作り
# (以後は使い回し。作り直すたびに内容が変わって dev の再ビルドが走らないように)、bundle-resources/ にコピーする。
# 合成音声のみで、人の録音は含まない。
set -euo pipefail

out="${1:?出力先の .wav を指定してください}"
text="${2:-確認します。}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

/usr/bin/say -v Kyoko -o "$tmp/say.wav" --file-format=WAVE --data-format=LEI16@16000 --channels=1 "$text"
# say の WAV は FLLR (パディング) チャンクを含むため、fmt + data だけの素の WAV に書き直す
# (受け側の WAV パーサーの差で失敗しないように)
python3 - "$tmp/say.wav" "$out" <<'EOF'
import sys, wave
with wave.open(sys.argv[1], "rb") as r:
    assert (r.getnchannels(), r.getsampwidth(), r.getframerate()) == (1, 2, 16000)
    frames = r.readframes(r.getnframes())
with wave.open(sys.argv[2], "wb") as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000)
    w.writeframes(frames)
EOF
echo "$out"
