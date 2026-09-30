# asr-bench

無口のASRを **Rustネイティブ** で動かせるかを判断するための検証ツール。
日本語追加学習モデル `neosophie/Qwen3-ASR-1.7B-JA` を、以下の実装で同じ音声にかけて精度・速度・メモリを比較する。

| label | 実装 | 備考 |
|---|---|---|
| `python-fp16` | Python + MLX ([mlx-qwen3-asr](https://pypi.org/project/mlx-qwen3-asr/) 0.4.4) | **ベースライン**。tsunagiのwhisper-serverと同じ実装・dtype |
| `python-8bit` | 同上 + 読み込み後に8bit量子化 | 配布時に想定する8bit版の目安 |
| `rust-candle` | Rust + Candle/Metal ([qwen3-asr](https://crates.io/crates/qwen3-asr) 0.2.2) | safetensorsを直接読み込み。量子化は未対応(bf16) |
| `rust-mlx` | Rust + MLX/mlx-c ([second-state/qwen3_asr_rs](https://github.com/second-state/qwen3_asr_rs)) | safetensorsを直接読み込み。量子化は未対応 |

## 合格基準(目安)

- 正解テキストに対するCERがベースラインと数ポイント以内
- 5秒程度の発話のレイテンシがベースライン同等以下
- 日本語モデルがそのまま(または簡単な変換で)読み込めること

## 必要なもの

- Apple Silicon Mac、[uv](https://docs.astral.sh/uv/)、Rust (rustup)
- `rust-mlx` のビルド: cmake、Metal Toolchain (`xcodebuild -downloadComponent MetalToolchain`)
- モデル: 初回実行時に Hugging Face から取得(約4GB)。tsunagi でダウンロード済みなら `~/.tsunagi/whisper/cache` を再利用する

## 手順

```bash
# 1. 自分の声で corpus.tsv の20文を録音 → data/audio/<id>.wav
#    (ターミナルにマイク権限が必要。録り直しは --redo <id>)
uv run scripts/record.py

# 2. Rust版をビルド
(cd rust && cargo build --release)

# 3. 全実装を実行して比較レポートを生成 → results/report.md
scripts/run_all.sh
```

`scripts/run_all.sh <audio_dir> <results_dir>` で音声と出力先を変えられる(例: macOSの `say` で作った音声での動作確認)。

## 出力

- `results/<label>.json`: 発話ごとの出力テキスト・レイテンシ・ロード時間
- `results/<label>.time.txt`: `/usr/bin/time -l` の出力(peak memory footprint を使う)
- `results/report.md`: CER(正解比)、vsBase(ベースライン出力との一致度)、短発話CER、レイテンシ中央値/p90、RTF、ロード時間、メモリ

CERはNFKC正規化・小文字化・句読点/空白除去後の文字単位編集距離。`Rust`/`ラスト` のような表記の違いも誤りとして数えるため、絶対値より実装間の差を見る。

## 配布モデルの比較 (P1'')

量子化済みチェックポイントの候補比較は `scripts/make_tts.sh` (複数話者のTTS音声) と `scripts/run_models.sh`。結果と決定は [MODEL_DECISION.md](MODEL_DECISION.md)。

`data/` と `results/` はコミットしない(音声は個人の声のため)。`models/` (変換済みモデル) も同様。
