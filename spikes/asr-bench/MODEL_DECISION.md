# 配布用8bit日本語モデルの決定 (P1'')

2026-09-30 / Apple M1 Max 64GB / mlx-qwen3-asr 0.4.4, mlx 0.32.0

## 結論

**`neosophie/Qwen3-ASR-1.7B-JA` を自前で全層8bit量子化 (group 64、エンコーダも8bit) したものを配布する。**

- 作り方: `mukuchi-asr-convert --model neosophie/Qwen3-ASR-1.7B-JA --bits 8 --out <dir>` (asr-server に同梱)。出力は決定的 (2回変換して weights.safetensors の SHA-256 一致)
- サイズ: 2.19GB (weights 2.17GB + トークナイザ等)。元の bf16 は 4.08GB
- 精度: fp16 と100発話中96が同一出力。CER 11.0% (fp16 10.7%、fp16の反復ハルシネーション1件を除く)。差は品質の低いTTS話者の固有名詞部分のみ
- 速度: レイテンシ中央値 -23% (277→213ms)、p90 -29% (789→557ms)
- メモリ: peak 2.93GB (fp16 8.50GB、読み込み後に量子化する方式 10.48GB)
- asr-server の変更は不要。mlx-qwen3-asr が `.scales` の有無と packed shape から層ごとのbit数を判定して読み込む。`--model <HFリポジトリID or ディレクトリ>` を渡すだけ
- ライセンス: Apache-2.0 (neosophie・Qwen3-ASR・mlx-qwen3-asr すべて Apache-2.0)。再配布可

## 候補と結果

音声: `data/tts` (macOS `say` の5話者 Kyoko/Eddy/Flo/Reed/Sandy × corpus 20文 = 100発話、`scripts/make_tts.sh`)。自分の声の録音 (`data/audio`) は未収録。

| label | 作り方 | ディスク | CER | CER(※) | fp16と同一 | vsBase | 中央値 | p90 | RTF | peak mem |
|---|---|---|---|---|---|---|---|---|---|---|
| fp16 | neosophie bf16 → 読み込み時 fp16 (現状) | 4.08GB | 17.0% | 10.7% | 100/100 | 0.0% | 277ms | 789ms | 0.068 | 8.50GB |
| runtime-8bit | fp16 を読み込み後にメモリ上で8bit化 | 4.08GB | 11.9% | 11.0% | 96/100 | 5.7% | 217ms | 559ms | 0.050 | 10.48GB |
| **ja-8bit** | **自前変換: 全層8bit** | **2.19GB** | 11.9% | 11.0% | 96/100 | 5.7% | 213ms | 557ms | 0.049 | 2.93GB |
| ja-8bit-enc16 | 自前変換: デコーダ8bit、エンコーダfp16 | 2.48GB | 11.7% | 10.8% | 97/100 | 5.5% | 218ms | 555ms | 0.050 | 3.33GB |
| mlxaudio-8bit | `ultragtx/Qwen3-ASR-1.7B-JA-8bit` (=ph0ryn版) | 2.48GB | 11.9% | 11.1% | 95/100 | 5.8% | 224ms | 559ms | 0.051 | 3.55GB |
| ja-4bit-enc8 | 自前変換: デコーダ4bit、エンコーダ8bit | 1.32GB | 17.8% | 11.8% | 57/100 | 13.7% | 177ms | 458ms | 0.042 | 2.07GB |

※ fp16 は `num01.eddy` で「2000年から2005年の…」を上限まで繰り返すハルシネーションを起こし (8bit系は短い誤りで止まる)、全体CERを押し上げている。CER(※) はこの1件を除いた値。
ロード時間はいずれも 0.4〜0.6s (ページキャッシュが温まった状態。コールドは未計測)。`data/smoke` (Kyoko 20文) でも 8bit系3種は fp16 と 20/20 同一、4bitは 14/20。

- 8bit系 (runtime / ja-8bit / enc16 / mlx-audio版) は互いにほぼ同一で、fp16 との差はノイズの範囲。ja-8bit と runtime-8bit は出力が完全一致 (同じ量子化のため)
- エンコーダを8bitにしても精度差は見られず (97 vs 96/100)、0.3GB小さく peak mem も0.4GB少ない → 全層8bitを採る
- 4bitデコーダはコマンド語 (「送信」→「装信」「ソーシング」) や数字の読みが崩れる。音声コマンドの完全一致判定に響くため不採用

## 既存の変換済みリポジトリについて

| リポジトリ | 形式 | mlx-qwen3-asr 0.4.4 | 由来 | 判断 |
|---|---|---|---|---|
| `ultragtx/Qwen3-ASR-1.7B-JA-8bit` | mlx-audio 0.4.3 変換。デコーダ8bit、エンコーダbf16、2.46GB | そのまま読める | カードは neosophie から変換と記載 (base_model タグは Qwen/Qwen3-ASR-1.7B)。エンコーダ重みが neosophie と bit 一致、デコーダは neosophie の8bit量子化誤差内 (max abs diff 0.003) を確認 | 使えるが不採用 |
| `ph0ryn/Qwen3-ASR-1.7B-JA-MLX-8bit` | 同上 | 同上 | model.safetensors の SHA-256 が ultragtx 版と同一 (同じ手順の再変換) | 同上 |
| `whnf/Qwen3-ASR-1.7B-JA-MLX` | mlx-qwen3-asr 0.3.5 変換、**非量子化 bf16** 4.7GB | (未検証) | neosophie | 8bitではないため対象外 |

既存8bit版を使わない理由: 個人リポジトリで削除・差し替えを制御できない、エンコーダ非量子化で0.3GB大きい、自前変換なら同じ精度を再現可能な手順で持てる。

## HFへの配置 (未実施)

アップロードはしていない。成果物はローカルの `spikes/asr-bench/models/ja-8bit/` (gitignore済み)。

1. org配下にリポジトリを作る (例: `minimalcorp/Qwen3-ASR-1.7B-JA-MLX-8bit`、名前は要決定)
2. `models/ja-8bit/` の全ファイルに以下を加えてアップロード (`hf upload <repo> models/ja-8bit`)
   - `LICENSE`: Apache-2.0 全文 (neosophie のリポジトリには LICENSE ファイルがなくメタデータのみのため、こちらで同梱する)
   - `README.md`: `license: apache-2.0`、`base_model: neosophie/Qwen3-ASR-1.7B-JA`、`library_name: mlx-qwen3-asr`、変更内容 (Apache-2.0 §4(b) の変更表示: 「MLX形式に変換し全層8bit (group 64) に量子化」)、再現コマンド、この文書の評価結果
3. アプリ・セットアップはリポジトリIDとコミットハッシュ (revision) を固定してダウンロードする。asr-server の `--model` にはダウンロード済みディレクトリか固定済みのリポジトリIDを渡す

アップロード後に変更が必要な箇所 (本作業では未変更):
- `asr-server` の `--model` 既定値 (`src/mukuchi_asr/__main__.py` の `DEFAULT_MODEL`)
- `process-compose.yaml` / `scripts/setup.sh` のモデルID (devenv-engineer)
- セットアップのモデルダウンロード (rust-engineer、P4)。ダウンロード量は約2.2GB

## 再現

```bash
cd spikes/asr-bench
scripts/make_tts.sh                                   # data/tts に100発話
HF_HOME=<neosophie取得済みのHF_HOME> uv run --project ../../asr-server mukuchi-asr-convert --out models/ja-8bit --bits 8
#   同様に --bits 8 --encoder-bits 16 → models/ja-8bit-enc16、--bits 4 --encoder-bits 8 → models/ja-4bit-enc8
HF_HOME=$PWD/models/hf uvx --from huggingface_hub hf download ultragtx/Qwen3-ASR-1.7B-JA-8bit
scripts/run_models.sh data/tts results-models         # → results-models/report.md
```
