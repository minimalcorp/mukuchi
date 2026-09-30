#!/usr/bin/env bash
# 初回セットアップの verify で使う検証用音声 (src-tauri/resources/verify.wav) を作り直す。
# 生成物はリポジトリに入れる (macOS の音声は環境で差があり、ビルドごとに作ると内容が変わりうるため)。
# 合成音声のみで、人の録音は含まない。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/src-tauri/resources/verify.wav"
text="${1:-確認します。}"
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
