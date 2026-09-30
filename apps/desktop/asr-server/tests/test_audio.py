import numpy as np
import pytest

from mukuchi_asr.audio import InvalidAudioError, decode_wav


def test_decode_scales_to_float(wav_bytes):
    pcm = np.array([0, 16384, -32768, 32767], dtype="<i2")
    audio = decode_wav(wav_bytes(pcm))
    assert audio.dtype == np.float32
    np.testing.assert_allclose(audio, [0.0, 0.5, -1.0, 32767 / 32768])


def test_decode_empty(wav_bytes):
    assert decode_wav(wav_bytes(np.zeros(0, dtype="<i2"))).size == 0


@pytest.mark.parametrize(
    "kwargs", [{"rate": 44100}, {"channels": 2}, {"width": 1}], ids=["rate", "stereo", "8bit"]
)
def test_decode_rejects_wrong_format(wav_bytes, kwargs):
    samples = np.zeros(100, dtype="<i2" if kwargs.get("width", 2) == 2 else "u1")
    with pytest.raises(InvalidAudioError):
        decode_wav(wav_bytes(samples, **kwargs))


@pytest.mark.parametrize("data", [b"", b"not a wav file at all", b"RIFF\x00\x00"])
def test_decode_rejects_garbage(data):
    with pytest.raises(InvalidAudioError):
        decode_wav(data)
