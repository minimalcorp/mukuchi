---
license: apache-2.0
base_model: neosophie/Qwen3-ASR-1.7B-JA
base_model_relation: quantized
library_name: llama.cpp
pipeline_tag: automatic-speech-recognition
language:
  - ja
  - en
tags:
  - gguf
  - llama.cpp
  - qwen3-asr
  - 8-bit
---

# Qwen3-ASR-1.7B-JA (GGUF, Q8_0)

A GGUF conversion of [neosophie/Qwen3-ASR-1.7B-JA](https://huggingface.co/neosophie/Qwen3-ASR-1.7B-JA) (revision `987bda160f2dabfa6757550bcff7cdda2ba0648c`), a Japanese fine-tune of [Qwen/Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B), for [llama.cpp](https://github.com/ggml-org/llama.cpp). Used by [mukuchi](https://github.com/minimalcorp/mukuchi), a local dictation app, as the recommended model for Japanese on Windows.

| file | size | contents |
|---|---|---|
| `Qwen3-ASR-1.7B-JA-Q8_0.gguf` | 1,834,422,688 B | text decoder, Q8_0 |
| `mmproj-Qwen3-ASR-1.7B-JA-Q8_0.gguf` | 355,709,760 B | audio encoder + projector, Q8_0 |

## Changes from the original (Apache-2.0 §4(b))

- Converted the weights to GGUF with `convert_hf_to_gguf.py` (llama.cpp b11408)
- Quantized to Q8_0 (the text decoder and the multimodal projector file separately)
- The tokenizer and config are embedded in the GGUF files, otherwise unchanged

## Evaluation

NVIDIA RTX 3080 Ti, llama-server b11408 (CUDA 13.4), language specified explicitly, no context. Synthetic speech (Windows SAPI voices, 5 speaking rates x 20 sentences) and real speech.

| set | metric | this model | original Qwen3-ASR-1.7B (Q8_0) |
|---|---|---|---|
| Japanese, 100 synthetic utterances (Haruka, 2270 chars) | CER | **8.2%** | 11.5% |
| English, 100 utterances from [LibriSpeech](https://www.openslr.org/12) test-clean (CC BY 4.0) | WER | 1.9% | 2.1% |
| English, 100 synthetic utterances (Zira, 935 words) | WER | 3.3% | 5.4% |

Median latency 90-135 ms, p90 140-300 ms per utterance (average 4.4 s of audio for the synthetic sets). The original model writes numbers as kanji numerals (e.g. 二千二十六年), this fine-tune writes Arabic numerals (2026年). The Japanese synthetic set is small and from a single voice; treat the numbers as indicative.

## Reproduce

```bash
# llama.cpp b11408 (https://github.com/ggml-org/llama.cpp/releases/tag/b11408)
python convert_hf_to_gguf.py <original model dir> --outtype q8_0 --outfile Qwen3-ASR-1.7B-JA-Q8_0.gguf
python convert_hf_to_gguf.py <original model dir> --outtype q8_0 --mmproj --outfile mmproj-Qwen3-ASR-1.7B-JA-Q8_0.gguf
```

SHA-256:

| file | SHA-256 |
|---|---|
| `Qwen3-ASR-1.7B-JA-Q8_0.gguf` | `77b760ea80ee34ac3c6746cf6028e3e0fd630b2fae26270bce1feb33b0a06ef5` |
| `mmproj-Qwen3-ASR-1.7B-JA-Q8_0.gguf` | `81356edc3c64538f130d9156843beee7f4f65d7354820f0d5cabbf9db9798f13` |

## Usage

```bash
llama-server -m Qwen3-ASR-1.7B-JA-Q8_0.gguf --mmproj mmproj-Qwen3-ASR-1.7B-JA-Q8_0.gguf -ngl 99
```

Send the audio to `/v1/chat/completions` as an `input_audio` content part (WAV, 16 kHz mono). The system message is used as a recognition hint (context). Passing the language explicitly (assistant prefill `language Japanese<asr_text>`) is recommended: short utterances are less reliable with automatic language detection.

**Known limitation:** like other Whisper-style/LLM ASR models, this model can emit text for non-speech input (silence, noise). In a 3-second digital-silence test it produced short filler text, and the original Qwen model could repeat a phrase until the token limit. Apply voice-activity detection before recognition and cap `max_tokens` by the audio length.

## License

Apache-2.0, same as the original model. See `LICENSE`.

The original fine-tune (`neosophie/Qwen3-ASR-1.7B-JA`) declares Apache-2.0 in its model card metadata and does not state its training data.
