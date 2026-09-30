# /// script
# requires-python = ">=3.10"
# dependencies = ["sounddevice", "numpy"]
# ///
"""corpus.tsv の各文を読み上げて録音し、data/audio/<id>.wav (16kHz/mono/16bit) に保存する。

使い方: uv run scripts/record.py [--redo ID ...]
Enterで録音開始 → 読み上げ → Enterで停止。停止後に r で録り直し、s でスキップ。
既に録音済みのIDは飛ばす(--redo で指定したIDは録り直す)。
"""

import argparse
import csv
import queue
import sys
import wave
from pathlib import Path

import numpy as np
import sounddevice as sd

ROOT = Path(__file__).resolve().parent.parent
AUDIO_DIR = ROOT / "data" / "audio"
SAMPLE_RATE = 16000


def load_corpus() -> list[tuple[str, str]]:
    with open(ROOT / "corpus.tsv", encoding="utf-8") as f:
        return [(r["id"], r["text"]) for r in csv.DictReader(f, delimiter="\t")]


def record_once() -> np.ndarray:
    q: queue.Queue[np.ndarray] = queue.Queue()

    def callback(indata, _frames, _time, status):
        if status:
            print(status, file=sys.stderr)
        q.put(indata.copy())

    input("  Enterで録音開始 > ")
    with sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="int16", callback=callback):
        input("  ● 録音中… 読み終えたらEnter > ")
    chunks = []
    while not q.empty():
        chunks.append(q.get())
    return np.concatenate(chunks) if chunks else np.zeros((0, 1), dtype=np.int16)


def save_wav(path: Path, samples: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(samples.tobytes())


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--redo", nargs="*", default=[], help="録り直すID")
    args = parser.parse_args()

    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    print(f"入力デバイス: {sd.query_devices(kind='input')['name']}")
    corpus = load_corpus()
    for i, (uid, text) in enumerate(corpus, 1):
        path = AUDIO_DIR / f"{uid}.wav"
        if path.exists() and uid not in args.redo:
            continue
        print(f"\n[{i}/{len(corpus)}] {uid}\n  「{text}」")
        while True:
            samples = record_once()
            sec = len(samples) / SAMPLE_RATE
            ans = input(f"  {sec:.1f}秒録音しました。保存=Enter / 録り直し=r / スキップ=s > ").strip().lower()
            if ans == "r":
                continue
            if ans != "s":
                save_wav(path, samples)
            break
    print(f"\n完了: {AUDIO_DIR}")


if __name__ == "__main__":
    main()
