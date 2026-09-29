"""FastAPIアプリ。モデルは呼び出し側で読み込み済みのワーカーを受け取る (テストで差し替えるため)。"""

import logging
import time

from fastapi import FastAPI, HTTPException, Request

from .audio import SAMPLE_RATE, InvalidAudioError, decode_wav
from .filters import is_hallucination_phrase
from .worker import InferenceWorker

logger = logging.getLogger("mukuchi_asr")

# 16kHz/16bit/mono × 120秒 ≈ 3.84MB。余裕を見て5MiBを上限とする
MAX_BODY_BYTES = 5 * 1024 * 1024


async def _read_body_limited(request: Request) -> bytes:
    length = request.headers.get("content-length")
    if length is not None and length.isdigit() and int(length) > MAX_BODY_BYTES:
        raise HTTPException(status_code=413, detail="request body too large")
    chunks = bytearray()
    async for chunk in request.stream():
        chunks += chunk
        if len(chunks) > MAX_BODY_BYTES:
            raise HTTPException(status_code=413, detail="request body too large")
    return bytes(chunks)


def create_app(worker: InferenceWorker, model_id: str) -> FastAPI:
    app = FastAPI(title="mukuchi-asr")

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "model": model_id}

    @app.post("/transcribe")
    async def transcribe(request: Request, language: str = "Japanese", context: str | None = None) -> dict:
        # 生bodyを読むためにasyncで受ける。推論は専用スレッドで行い、その完了をawaitするので
        # イベントループは塞がれず推論中も/healthが応答できる。
        data = await _read_body_limited(request)
        # elapsed_ms = WAVデコード + 推論待ち(キュー) + 推論 の合計 (body受信完了からの経過)
        t0 = time.perf_counter()
        try:
            audio = decode_wav(data)
        except InvalidAudioError as e:
            raise HTTPException(status_code=400, detail=str(e)) from e
        text = ""
        if audio.size > 0:
            text = (await worker.transcribe(audio, language, context or "")).strip()
            if is_hallucination_phrase(text):
                logger.info("dropped hallucination phrase: %r", text)
                text = ""
        elapsed_ms = round((time.perf_counter() - t0) * 1000)
        logger.info("transcribed %.2fs audio in %dms: %r", audio.size / SAMPLE_RATE, elapsed_ms, text)
        return {"text": text, "elapsed_ms": elapsed_ms}

    return app
