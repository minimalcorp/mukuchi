"""mukuchi-asr-convert で作ったチェックポイントを mlx-qwen3-asr がそのまま読めることの確認。

実モデル(数GB)は使わず、同じ構造の極小モデルで往復させる。mlx-qwen3-asr を上げた時に
混合精度(4bitデコーダ + 8bitエンコーダ)や tied lm_head の復元が壊れていないかを検出するため。
"""

import json

import mlx.core as mx
import mlx.nn as nn
import mlx.utils as mlx_utils
import pytest
from mlx_qwen3_asr.config import Qwen3ASRConfig
from mlx_qwen3_asr.convert import quantize_model
from mlx_qwen3_asr.load_models import load_model
from mlx_qwen3_asr.model import Qwen3ASRModel

from mukuchi_asr.convert import convert

TINY_CONFIG = {
    "thinker_config": {
        "audio_config": {
            "num_mel_bins": 128,
            "encoder_layers": 1,
            "encoder_attention_heads": 2,
            "encoder_ffn_dim": 128,
            "d_model": 64,
            "output_dim": 64,
            "downsample_hidden_size": 8,
        },
        "text_config": {
            "vocab_size": 256,
            "hidden_size": 64,
            "intermediate_size": 128,
            "num_hidden_layers": 1,
            "num_attention_heads": 1,
            "num_key_value_heads": 1,
            "head_dim": 128,  # MRoPEの区間(24+20+20)が head_dim//2 と一致する必要がある
            "tie_word_embeddings": True,
        },
    }
}


@pytest.fixture
def source_dir(tmp_path):
    """HF形式に相当する元チェックポイント (tied embedding なので lm_head を含まない)。"""
    src = tmp_path / "src"
    src.mkdir()
    (src / "config.json").write_text(json.dumps(TINY_CONFIG))
    (src / "vocab.json").write_text("{}")
    mx.random.seed(0)
    model = Qwen3ASRModel(Qwen3ASRConfig.from_dict(TINY_CONFIG))
    flat = {k: v for k, v in mlx_utils.tree_flatten(model.parameters()) if not k.startswith("lm_head.")}
    mx.save_safetensors(str(src / "model.safetensors"), flat)
    return src


def _bits(module) -> int | None:
    return module.bits if isinstance(module, (nn.QuantizedLinear, nn.QuantizedEmbedding)) else None


@pytest.mark.parametrize(("bits", "encoder_bits"), [(8, 8), (4, 8), (8, 16)])
def test_converted_checkpoint_loads_with_same_weights(source_dir, tmp_path, bits, encoder_bits):
    out = tmp_path / "out"
    convert(source_dir, out, bits=bits, encoder_bits=encoder_bits)

    assert (out / "vocab.json").exists()
    assert json.loads((out / "quantization_config.json").read_text())["audio_tower_bits"] == encoder_bits
    assert not any(k.startswith("lm_head.") for k in mx.load(str(out / "weights.safetensors")))

    loaded, _ = load_model(str(out))
    encoder_linear = loaded.audio_tower.layers[0].fc1
    assert _bits(encoder_linear) == (None if encoder_bits == 16 else encoder_bits)
    assert _bits(loaded.model.layers[0].mlp.gate_proj) == bits
    assert _bits(loaded.model.embed_tokens) == bits
    assert _bits(loaded.lm_head) == bits

    # 読み込んだ重みが、元モデルをメモリ上で同じ設定で量子化したものと一致すること
    expected = Qwen3ASRModel(Qwen3ASRConfig.from_dict(TINY_CONFIG))
    expected.load_weights(str(source_dir / "model.safetensors"), strict=False)
    expected.lm_head.weight = expected.model.embed_tokens.weight
    expected.update(mlx_utils.tree_map(lambda x: x.astype(mx.float16), expected.parameters()))
    quantize_model(expected, bits=bits, encoder_bits=encoder_bits)
    want = dict(mlx_utils.tree_flatten(expected.parameters()))
    got = dict(mlx_utils.tree_flatten(loaded.parameters()))
    assert want.keys() == got.keys()
    for k, v in want.items():
        assert mx.array_equal(got[k], v).item(), k
