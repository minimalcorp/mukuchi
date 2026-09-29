"""エントリポイント: `mukuchi-asr --port 18765 --model <HF repo id or path>`。"""

import argparse
import logging
import os
import sys
import threading
import time

import numpy as np
import uvicorn

from .app import create_app
from .audio import SAMPLE_RATE
from .worker import InferenceWorker, Transcriber

HOST = "127.0.0.1"
DEFAULT_PORT = 18765
DEFAULT_MODEL = "neosophie/Qwen3-ASR-1.7B-JA"

logger = logging.getLogger("mukuchi_asr")


def _watch_stdin_eof() -> None:
    # 親(Rust)がパイプで起動し、親が異常終了してもパイプが閉じてEOFになる。
    # それを検知して即終了し、孤児プロセスとしてポートやメモリを握り続けないようにする。
    # 推論中でも待たずに終わらせたいので、graceful shutdownではなく os._exit を使う。
    # sys.stdin はfd 0が閉じた状態で起動されるとNoneになるため、fdを直接読む。
    # 読めない(EBADF等)場合もEOFとみなす。
    try:
        while os.read(0, 4096):
            pass
    except Exception:
        pass
    logger.info("stdin closed; exiting")
    logging.shutdown()
    os._exit(0)


def _load(model: str) -> Transcriber:
    logger.info("loading model %s", model)
    t0 = time.perf_counter()
    from mlx_qwen3_asr import Session

    session = Session(model=model)
    logger.info("model loaded in %.1fs", time.perf_counter() - t0)

    def transcribe(audio: np.ndarray, language: str, context: str) -> str:
        return session.transcribe(audio, language=language, context=context).text

    # 初回推論はMetalカーネルのコンパイル等で遅いため、待受前に済ませて最初の発話を待たせない
    t0 = time.perf_counter()
    transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32), "Japanese", "")
    logger.info("warmup done in %.1fs", time.perf_counter() - t0)
    return transcribe


def main() -> None:
    parser = argparse.ArgumentParser(prog="mukuchi-asr")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Hugging FaceリポジトリID or ローカルパス")
    parser.add_argument(
        "--exit-on-stdin-eof", action="store_true", help="stdinがEOFになったら終了する (親プロセス死活監視)"
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO, stream=sys.stdout, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )

    # モデル読み込み中に親が死んだ場合も終われるよう、読み込み前から監視する
    if args.exit_on_stdin_eof:
        threading.Thread(target=_watch_stdin_eof, name="stdin-eof", daemon=True).start()

    # 読み込み・ウォームアップ・推論はすべてworkerの専用スレッドで行う (MLXのスレッド束縛のため)。
    # 読み込み完了まで待受を始めないことで「/healthが応答する=利用可能」を保証する
    worker = InferenceWorker(lambda: _load(args.model))
    worker.load()

    app = create_app(worker, args.model)
    uvicorn.run(app, host=HOST, port=args.port, log_config=None, access_log=False)


if __name__ == "__main__":
    main()
