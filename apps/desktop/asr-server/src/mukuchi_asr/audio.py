"""WAVデコード。

Rustから送られるのは16kHz/mono/16bit PCMのWAVに限定されるため、ffmpeg/PyAVに頼らず
標準ライブラリの `wave` で読む (依存を増やさず、配布サイズを抑えるため)。
"""

import io
import wave

import numpy as np

SAMPLE_RATE = 16000


class InvalidAudioError(ValueError):
    pass


def decode_wav(data: bytes) -> np.ndarray:
    """16kHz/mono/s16のWAVを[-1, 1)のfloat32配列にする。形式違いはInvalidAudioError。"""
    try:
        with wave.open(io.BytesIO(data), "rb") as w:
            channels, width, rate = w.getnchannels(), w.getsampwidth(), w.getframerate()
            frames = w.readframes(w.getnframes())
    except (wave.Error, EOFError) as e:
        raise InvalidAudioError(f"invalid WAV: {type(e).__name__}: {e}") from e
    if (channels, width, rate) != (1, 2, SAMPLE_RATE):
        raise InvalidAudioError(f"expected 16kHz mono s16 WAV, got {rate}Hz {channels}ch {width * 8}bit")
    # ヘッダのフレーム数より実データが短い壊れたWAVでも、読めた分だけ使う
    usable = len(frames) - len(frames) % 2
    pcm = np.frombuffer(frames[:usable], dtype="<i2")
    return pcm.astype(np.float32) / 32768.0
