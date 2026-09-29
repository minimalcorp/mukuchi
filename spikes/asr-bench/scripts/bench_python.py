# /// script
# requires-python = ">=3.10"
# dependencies = ["mlx-qwen3-asr==0.4.4", "mlx==0.32.0", "numpy"]
# ///
"""ベースライン: Python + MLX (mlx-qwen3-asr、tsunagiのwhisper-serverと同じ実装)。

使い方: uv run scripts/bench_python.py --model <HFリポジトリID or ローカルパス> --label <名前> [--quantize 8]
既定のdtypeはfloat16(tsunagiと同じ)。
結果は $RESULTS_DIR (既定: results/) の <label>.json に書き出す(形式はRust版と共通)。
"""

import argparse
import json
import os
import time
import wave
from pathlib import Path

import numpy as np
import mlx.core as mx
from mlx_qwen3_asr import Session
from mlx_qwen3_asr.convert import quantize_model

ROOT = Path(__file__).resolve().parent.parent


def load_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2, path
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return pcm.astype(np.float32) / 32768.0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--quantize", type=int, choices=[4, 8], help="読み込み後にメモリ上で量子化する(配布時の8bit版の目安)")
    parser.add_argument("--audio-dir", default=str(ROOT / "data" / "audio"))
    args = parser.parse_args()

    files = sorted(Path(args.audio_dir).glob("*.wav"))
    if not files:
        raise SystemExit(f"音声がありません: {args.audio_dir}")

    t0 = time.perf_counter()
    session = Session(model=args.model)
    if args.quantize:
        quantize_model(session.model, bits=args.quantize)
        mx.eval(session.model.parameters())
    load_ms = (time.perf_counter() - t0) * 1000

    # 初回推論はMetalカーネルのコンパイル等で遅いため、計測から除外する。
    session.transcribe(load_wav(files[0]), language="Japanese")

    results = []
    for f in files:
        audio = load_wav(f)
        t = time.perf_counter()
        text = session.transcribe(audio, language="Japanese").text
        latency_ms = (time.perf_counter() - t) * 1000
        results.append({"id": f.stem, "text": text, "latency_ms": latency_ms, "audio_sec": len(audio) / 16000})
        print(f"{f.stem}\t{latency_ms:7.0f}ms\t{text}")

    out = Path(os.environ.get("RESULTS_DIR", ROOT / "results")) / f"{args.label}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps({"label": args.label, "impl": "python-mlx", "model": args.model, "quantize": args.quantize,
                               "load_ms": load_ms, "results": results}, ensure_ascii=False, indent=1))
    print(f"-> {out}")


if __name__ == "__main__":
    main()
