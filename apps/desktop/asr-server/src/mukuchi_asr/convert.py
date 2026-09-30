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


def convert(src: Path, out: Path, bits: int, encoder_bits: int, group_size: int = 64) -> None:
    """src (HF形式のローカルディレクトリ) を量子化して out に保存する。

    encoder_bits=16 は音声エンコーダを量子化しない。
    """
    # mlxはApple Silicon専用でimportが重いため、CLIとして呼ばれた時だけ読み込む
    import mlx.core as mx
    import mlx.utils as mlx_utils
    from mlx_qwen3_asr.config import Qwen3ASRConfig
    from mlx_qwen3_asr.convert import quantize_model, remap_weights
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
    quantize_model(model, bits=bits, group_size=group_size, encoder_bits=encoder_bits)

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
    parser.add_argument("--bits", type=int, choices=[4, 8], required=True, help="テキストデコーダのbit数")
    parser.add_argument(
        "--encoder-bits", type=int, choices=[4, 8, 16], help="エンコーダのbit数 (16=非量子化)"
    )
    parser.add_argument("--group-size", type=int, choices=[32, 64, 128], default=64)
    args = parser.parse_args()

    from mlx_qwen3_asr.load_models import _resolve_path

    encoder_bits = args.encoder_bits or args.bits
    convert(_resolve_path(args.model), args.out, args.bits, encoder_bits, args.group_size)
    print(f"-> {args.out} (decoder {args.bits}bit, encoder {encoder_bits}bit, group {args.group_size})")


if __name__ == "__main__":
    main()
