"""配布用の量子化済みチェックポイントを作る (`mukuchi-asr-convert`)。サーバー実行時には使わない。

使い方:
  mukuchi-asr-convert --model neosophie/Qwen3-ASR-1.7B-JA --out <出力先> --bits 8

mlx-qwen3-asr v0.4.4 の scripts/convert.py (wheelに含まれない) と同じ手順
(HFの重みをremap → float16 → quantize_model → weights.safetensors + quantization_config.json) に、
次の2点を加えている。
- 元のチェックポイントは tied embedding で lm_head.weight を持たないため、embed_tokens から補ってから
  読み込む (upstreamのscriptは neosophie/Qwen3-ASR-1.7B-JA で "Missing lm_head.weight" になる)
- chat_template 等、再配布に必要なファイルもコピーする

読み込み側 (mlx_qwen3_asr.load_models) は .scales の有無と packed shape から層ごとのbit数を判定するため、
サーバーは `--model <出力先 or HFリポジトリ>` を渡すだけで読める。

5bit について: mlx (0.32) の affine 量子化は 2/3/4/5/6/8bit を扱えるが、mlx-qwen3-asr 0.4.4 は
- quantize_model が bits/encoder_bits を 2/4/8(/16) に制限している → 同じ手順を nn.quantize で直接行う
- 読み込み時の層ごとの判定 (_infer_module_quantization) が 2/4/8 しか認めず、判定できない層は
  quantization_config.json の "bits" (=デコーダのbit数) で量子化し直す
ため、5bit の層は「デコーダのbit数が5」の時だけ正しく読める。エンコーダだけを5bitにする組み合わせは
読み込みで壊れるので受け付けない。
"""

import argparse
import json
import shutil
from pathlib import Path

# 重み以外で推論・再配布に必要なもの (トークナイザ、テンプレート、元のconfig)
COPY_FILES = (
    "config.json",
    "generation_config.json",
    "preprocessor_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.json",
    "merges.txt",
    "special_tokens_map.json",
    "added_tokens.json",
    "chat_template.json",
    "chat_template.jinja",
)


def check_bits(bits: int, encoder_bits: int) -> None:
    """mlx-qwen3-asr 0.4.4 で読み戻せる組み合わせか確かめる (モジュール docstring の「5bit について」)。"""
    if encoder_bits == 5 and bits != 5:
        raise ValueError("エンコーダの5bitはデコーダも5bitの時だけ指定できる (読み込み側が判定できないため)")


def quantize(model, bits: int, group_size: int, encoder_bits: int) -> None:
    """mlx_qwen3_asr.convert.quantize_model と同じ手順で量子化する (5bit を許すため自前で呼ぶ)。

    4/8bit の結果は quantize_model と一致する (tests/test_convert.py で確認)。
    """
    import mlx.nn as nn

    def is_encoder(path: str) -> bool:
        return path.startswith("audio_tower")

    def quantizable(module) -> bool:
        return isinstance(module, (nn.Linear, nn.Embedding))

    if encoder_bits == bits:
        nn.quantize(model, bits=bits, group_size=group_size)
        return
    nn.quantize(
        model,
        bits=bits,
        group_size=group_size,
        class_predicate=lambda path, m: quantizable(m) and not is_encoder(path),
    )
    if encoder_bits != 16:
        nn.quantize(
            model,
            bits=encoder_bits,
            group_size=group_size,
            class_predicate=lambda path, m: quantizable(m) and is_encoder(path),
        )


def convert(src: Path, out: Path, bits: int, encoder_bits: int, group_size: int = 64) -> None:
    """src (HF形式のローカルディレクトリ) を量子化して out に保存する。

    encoder_bits=16 は音声エンコーダを量子化しない。
    """
    check_bits(bits, encoder_bits)
    # mlxはApple Silicon専用でimportが重いため、CLIとして呼ばれた時だけ読み込む
    import mlx.core as mx
    import mlx.utils as mlx_utils
    from mlx_qwen3_asr.config import Qwen3ASRConfig
    from mlx_qwen3_asr.convert import remap_weights
    from mlx_qwen3_asr.load_models import (
        _load_safetensors,
        _materialize_tied_lm_head_weights,
        _model_uses_tied_lm_head,
    )
    from mlx_qwen3_asr.model import Qwen3ASRModel

    config = Qwen3ASRConfig.from_dict(json.loads((src / "config.json").read_text(encoding="utf-8")))
    weights = {k: v.astype(mx.float16) for k, v in remap_weights(_load_safetensors(src)).items()}
    weights = _materialize_tied_lm_head_weights(weights, config)
    model = Qwen3ASRModel(config)
    model.load_weights(list(weights.items()))
    quantize(model, bits, group_size, encoder_bits)

    out.mkdir(parents=True, exist_ok=True)
    flat = dict(mlx_utils.tree_flatten(model.parameters()))
    # tied embedding の lm_head は読み込み時に embed_tokens から復元されるため保存しない
    # (1.7Bの8bitで約0.3GB削減)
    if _model_uses_tied_lm_head(config):
        for k in [k for k in flat if k.startswith("lm_head.")]:
            del flat[k]
    mx.save_safetensors(str(out / "weights.safetensors"), flat, metadata={"format": "mlx"})
    for name in COPY_FILES:
        if (src / name).exists():
            shutil.copy2(src / name, out / name)
    quant_cfg = {"bits": bits, "group_size": group_size, "audio_tower_bits": encoder_bits}
    (out / "quantization_config.json").write_text(json.dumps(quant_cfg, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(prog="mukuchi-asr-convert")
    parser.add_argument(
        "--model", default="neosophie/Qwen3-ASR-1.7B-JA", help="元モデルのHFリポジトリID or ローカルパス"
    )
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--bits", type=int, choices=[4, 5, 8], required=True, help="テキストデコーダのbit数")
    parser.add_argument(
        "--encoder-bits",
        type=int,
        choices=[4, 5, 8, 16],
        help="エンコーダのbit数 (16=非量子化。5はデコーダも5の時のみ)",
    )
    parser.add_argument("--group-size", type=int, choices=[32, 64, 128], default=64)
    args = parser.parse_args()

    from mlx_qwen3_asr.load_models import _resolve_path

    encoder_bits = args.encoder_bits or args.bits
    try:
        check_bits(args.bits, encoder_bits)
    except ValueError as e:
        parser.error(str(e))
    convert(_resolve_path(args.model), args.out, args.bits, encoder_bits, args.group_size)
    print(f"-> {args.out} (decoder {args.bits}bit, encoder {encoder_bits}bit, group {args.group_size})")


if __name__ == "__main__":
    main()
