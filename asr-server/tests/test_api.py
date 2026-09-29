import threading
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from mukuchi_asr.app import MAX_BODY_BYTES, create_app
from mukuchi_asr.worker import InferenceWorker

MODEL = "test/model"


class FakeTranscriber:
    def __init__(self, text="こんにちは"):
        self.text = text
        self.calls = []
        self.threads = []

    def __call__(self, audio, language, context):
        self.calls.append((audio, language, context))
        self.threads.append(threading.get_ident())
        return self.text


def make_client(transcriber, loader_threads=None):
    def loader():
        if loader_threads is not None:
            loader_threads.append(threading.get_ident())
        return transcriber

    worker = InferenceWorker(loader)
    worker.load()
    return TestClient(create_app(worker, MODEL))


@pytest.fixture
def fake():
    return FakeTranscriber()


@pytest.fixture
def client(fake):
    return make_client(fake)


def post(client, body, **params):
    return client.post("/transcribe", content=body, params=params, headers={"Content-Type": "audio/wav"})


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "model": MODEL}


def test_transcribe_defaults(client, fake, wav_bytes):
    r = post(client, wav_bytes(np.full(1600, 1000, dtype="<i2")))
    assert r.status_code == 200
    body = r.json()
    assert body["text"] == "こんにちは"
    assert isinstance(body["elapsed_ms"], int)
    audio, language, context = fake.calls[0]
    assert audio.shape == (1600,) and audio.dtype == np.float32
    assert language == "Japanese" and context == ""


def test_transcribe_passes_language_and_context(client, fake, wav_bytes):
    post(client, wav_bytes(np.zeros(160, dtype="<i2")), language="English", context="Tauri Rust")
    assert fake.calls[0][1:] == ("English", "Tauri Rust")


def test_transcribe_strips_text(client, fake, wav_bytes):
    fake.text = "  了解です。\n"
    assert post(client, wav_bytes(np.zeros(160, dtype="<i2"))).json()["text"] == "了解です。"


def test_hallucination_is_dropped(client, fake, wav_bytes):
    fake.text = "ご視聴ありがとうございました。"
    assert post(client, wav_bytes(np.zeros(160, dtype="<i2"))).json()["text"] == ""


def test_empty_audio_skips_model(client, fake, wav_bytes):
    r = post(client, wav_bytes(np.zeros(0, dtype="<i2")))
    assert r.status_code == 200
    assert r.json()["text"] == ""
    assert fake.calls == []


@pytest.mark.parametrize("body", [b"", b"garbage"])
def test_invalid_audio_is_400(client, fake, body):
    assert post(client, body).status_code == 400
    assert fake.calls == []


def test_wrong_format_is_400(client, wav_bytes):
    assert post(client, wav_bytes(np.zeros(100, dtype="<i2"), rate=48000)).status_code == 400


def test_inference_is_serialized_and_health_stays_responsive(wav_bytes):
    active = 0
    max_active = 0
    guard = threading.Lock()

    def slow(audio, language, context):
        nonlocal active, max_active
        with guard:
            active += 1
            max_active = max(max_active, active)
        time.sleep(0.3)
        with guard:
            active -= 1
        return "ok"

    client = make_client(slow)
    body = wav_bytes(np.zeros(160, dtype="<i2"))
    threads = [threading.Thread(target=post, args=(client, body)) for _ in range(3)]
    for t in threads:
        t.start()
    time.sleep(0.1)
    t0 = time.perf_counter()
    assert client.get("/health").status_code == 200
    assert time.perf_counter() - t0 < 0.2
    for t in threads:
        t.join()
    assert max_active == 1


def test_load_and_all_inference_run_on_one_dedicated_thread(fake, wav_bytes):
    # MLXの配列・ストリームは生成スレッドに束縛されるため、読み込みと全推論が同一スレッドである必要がある
    loader_threads = []
    client = make_client(fake, loader_threads)
    body = wav_bytes(np.zeros(160, dtype="<i2"))
    threads = [threading.Thread(target=post, args=(client, body)) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    for _ in range(3):
        assert post(client, body).status_code == 200
    assert len(loader_threads) == 1
    assert loader_threads[0] != threading.get_ident()
    assert len(fake.threads) == 8
    assert set(fake.threads) == set(loader_threads)


def test_body_too_large_is_413(client, fake):
    r = post(client, b"\0" * (MAX_BODY_BYTES + 1))
    assert r.status_code == 413
    assert fake.calls == []


def test_body_too_large_without_content_length_is_413(client, fake):
    def gen():
        for _ in range(6):
            yield b"\0" * (1024 * 1024)

    r = client.post("/transcribe", content=gen(), headers={"Content-Type": "audio/wav"})
    assert r.status_code == 413
    assert fake.calls == []


def test_transcribe_before_load_fails():
    import asyncio

    worker = InferenceWorker(lambda: FakeTranscriber())
    with pytest.raises(RuntimeError):
        asyncio.run(worker.transcribe(np.zeros(1, dtype=np.float32), "Japanese", ""))
