---
license: apache-2.0
base_model: Qwen/Qwen3-ASR-1.7B
base_model_relation: quantized
library_name: llama.cpp
pipeline_tag: automatic-speech-recognition
language:
  - en
  - ja
tags:
  - gguf
  - llama.cpp
  - qwen3-asr
  - 8-bit
---

# Qwen3-ASR-1.7B (GGUF, Q8_0)

A GGUF conversion of [Qwen/Qwen3-ASR-1.7B](https://huggingface.co/Qwen/Qwen3-ASR-1.7B) (revision `7278e1e70fe206f11671096ffdd38061171dd6e5`) for [llama.cpp](https://github.com/ggml-org/llama.cpp). Used by [mukuchi](https://github.com/minimalcorp/mukuchi), a local dictation app, as the recommended model for English on Windows. (The llama.cpp project also publishes [ggml-org/Qwen3-ASR-1.7B-GGUF](https://huggingface.co/ggml-org/Qwen3-ASR-1.7B-GGUF); this conversion scored the same within noise.)

The original model supports 30 languages and 22 Chinese dialects. Only English and Japanese were evaluated for this conversion.

| file | size | contents |
|---|---|---|
| `Qwen3-ASR-1.7B-Q8_0.gguf` | 2,165,035,008 B | text decoder, Q8_0 |
| `mmproj-Qwen3-ASR-1.7B-Q8_0.gguf` | 355,709,376 B | audio encoder + projector, Q8_0 |

## Changes from the original (Apache-2.0 §4(b))

- Converted the weights to GGUF with `convert_hf_to_gguf.py` (llama.cpp b11408)
- Quantized to Q8_0 (the text decoder and the multimodal projector file separately)
- The tokenizer and config are embedded in the GGUF files, otherwise unchanged

## Evaluation

NVIDIA RTX 3080 Ti, llama-server b11408 (CUDA 13.4), language specified explicitly, no context.

| set | metric | this model |
|---|---|---|
| English, 100 utterances from [LibriSpeech](https://www.openslr.org/12) test-clean (CC BY 4.0) | WER | 2.1% (46 errors / 2111 words) |
| English, 100 synthetic utterances (Windows SAPI Zira, 5 speaking rates x 20 sentences, 935 words) | WER | 5.4% (1.3% excluding sentences with digits) |
| Japanese, 100 synthetic utterances (Haruka) | CER | 11.5% |

Median latency 90-135 ms, p90 160-320 ms per utterance. For Japanese, the fine-tuned [Qwen3-ASR-1.7B-JA](https://huggingface.co/minimalcorp/Qwen3-ASR-1.7B-JA-GGUF) scored CER 8.2% on the same set. The synthetic sets use a single voice; treat the numbers as indicative.

## Reproduce

```bash
# llama.cpp b11408 (https://github.com/ggml-org/llama.cpp/releases/tag/b11408)
python convert_hf_to_gguf.py <original model dir> --outtype q8_0 --outfile Qwen3-ASR-1.7B-Q8_0.gguf
python convert_hf_to_gguf.py <original model dir> --outtype q8_0 --mmproj --outfile mmproj-Qwen3-ASR-1.7B-Q8_0.gguf
```

SHA-256:

| file | SHA-256 |
|---|---|
| `Qwen3-ASR-1.7B-Q8_0.gguf` | `05e7c6bef93aeb4bb3e9f4b942806be600a219ee68485618bbcc38df0f2f6c2a` |
| `mmproj-Qwen3-ASR-1.7B-Q8_0.gguf` | `8fd6ec0c6fc644e4940e18063de6cc59cfce177d2b88af92efad3a5fcb7a04ef` |

## Usage

```bash
llama-server -m Qwen3-ASR-1.7B-Q8_0.gguf --mmproj mmproj-Qwen3-ASR-1.7B-Q8_0.gguf -ngl 99
```

Send the audio to `/v1/chat/completions` as an `input_audio` content part (WAV, 16 kHz mono). The system message is used as a recognition hint (context). Passing the language explicitly (assistant prefill `language English<asr_text>`) is recommended: short utterances are less reliable with automatic language detection.

**Known limitation:** like other Whisper-style/LLM ASR models, this model can emit text for non-speech input (silence, noise). In a 3-second digital-silence test it produced short filler text, and the original Qwen model could repeat a phrase until the token limit. Apply voice-activity detection before recognition and cap `max_tokens` by the audio length.

## License

Apache-2.0, same as the original model. See `LICENSE`.
