# 話す言語 (ja / en) ごとのモデルの比較 (i18n)

2026-10-06 / Apple M1 Max 64GB, macOS 26.6.2 / mlx-qwen3-asr 0.4.4, mlx 0.32.0。計画は [docs/plans/i18n-plan.md](../../docs/plans/i18n-plan.md)「話す言語ごとの推奨モデル」。
**推奨・並びは案。決定はユーザー。** HF へのアップロードは未実施。

## 要約

- 5bit・0.6B とも変換・読み込み・asr-server での起動を確認した (変換器に 5bit を追加。下の「5bit の対応」)
- ja: **ja-8bit が最良** (CER 11.9%、数字をアラビア数字で書く)。元の Qwen は数字を漢数字で書き、CER が上がる。計画の仮の並びと一致
- en: 4モデルの差は小さく、**サンプル数に対してノイズの範囲**。LibriSpeech では ja-8bit が最も低い WER (1.8%) だが、2111語中の誤り 38 vs 43 語の差で有意とは言えない。計画の仮 (`ja-8bit` を最下位) を支える計測結果は無い
- 5bit は 8bit と精度がほぼ同じ (en は 92〜94/100 発話が 8bit と同一出力)、0.76GB 小さく、速度は 5〜10% 速い
- 0.6B は 1.6〜1.8倍速く 0.84GB だが、ja は明確に劣る (CER 17.5%、出力の6割以上が 1.7B と異なる)。en は TTS では差が無く、LibriSpeech で誤りが 1.2倍

## 対象モデル

| id | 元 (revision) | ライセンス | bit (group 64、エンコーダも同じ) | HF に上げる合計 |
|---|---|---|---|---|
| ja-8bit (既存 `minimalcorp/Qwen3-ASR-1.7B-JA-MLX-8bit` @`698eff963b084561b12a045c95bc4a208898337f`) | `neosophie/Qwen3-ASR-1.7B-JA` @`987bda160f2dabfa6757550bcff7cdda2ba0648c` | Apache-2.0 | 8 | 2,185,820,517 B (公開済み、全16ファイル) |
| base-1.7b-8bit | `Qwen/Qwen3-ASR-1.7B` @`7278e1e70fe206f11671096ffdd38061171dd6e5` | Apache-2.0 | 8 | 2,174,372,462 B + LICENSE 11,358 B + README・.gitattributes (数KB) |
| base-1.7b-5bit | 同上 | Apache-2.0 | 5 | 1,411,827,624 B + 同上 |
| base-0.6b-8bit | `Qwen/Qwen3-ASR-0.6B` @`5eb144179a02acc5e5ba31e748d22b0cf3e303b0` | Apache-2.0 | 8 | 840,088,503 B + 同上 |

- ライセンスは各 HF カードのメタデータ (`license: apache-2.0`) で確認。Qwen の2リポジトリ・neosophie とも **LICENSE ファイルは置いていない** (メタデータのみ)
- 変換出力 (`models/<id>/`) は weights.safetensors + config・トークナイザ等。Qwen 公式には `tokenizer.json` が無いため、ja-8bit より約11MB小さい (mlx-qwen3-asr は vocab.json + merges.txt で動き、tokenizer.json は使わない)
- weights.safetensors の SHA-256: base-1.7b-8bit `663b67fbd1e05547d97ad2922eb7bd1fe096b1b1e02289ffb8e9a624c4d17b67`、base-1.7b-5bit `f8d19e254141a786f43bc935e8dd64cbc051b64dfe60ce4a1979ddfd7094d1f9`、base-0.6b-8bit `2b8598c9eecc4a30e5edfb793ace7623b849bf3812f18523256fa005c41ff0d4`

### 5bit の対応 (ソースで確認)

- mlx 0.32.0: affine 量子化は bits 2/3/4/5/6/8 (`mx.quantize` の docstring の表)。5bit で (1024, 2048) を量子化すると packed (1024, 320) uint32 になり、`quantized_matmul` の相対誤差は 4bit 0.090 / 5bit 0.044 / 8bit 0.0055 (乱数行列での確認)
- mlx-qwen3-asr 0.4.4:
  - `convert.quantize_model` は `encoder_bits` (省略時は bits) を 2/4/8/16 に制限し 5 で ValueError → 変換器は同じ手順を `nn.quantize` で直接行う (4/8bit の結果は quantize_model と一致することをテストで確認)
  - 読み込み (`load_models._infer_module_quantization`) は packed shape から層ごとの bit を出すが **2/4/8 しか認めない**。判定できない層は `quantization_config.json` の `bits` (デコーダの bit) で量子化し直す。よって 5bit の層が正しく読めるのは**デコーダが5bitの時だけ** (全層5bit、デコーダ5bit + エンコーダ 8/4/16 は可。エンコーダだけ5bitは不可で、変換器で拒否する)
  - `quantization_config.json` が無いと bit を多数決 (4/8 のみ) で推定するため、5bit のチェックポイントには必須 (変換器が常に書く)
- 実機: 全層5bit の base-1.7b-5bit を Session / asr-server で読み込み、精度が 8bit とほぼ同じことを確認 (下の結果)

### 0.6B

mlx-qwen3-asr は 0.6B を公式に扱う (`config.py` に `for_0_6b`、既定モデルも `Qwen/Qwen3-ASR-0.6B`)。構成は config.json から読むため変換器の変更は不要。tied embedding (lm_head 無し) も 1.7B と同じ扱い。

## 計測データ

| set | 音声 | 発話 | 規模 | 言語指定 | 主指標 |
|---|---|---|---|---|---|
| ja | macOS `say` Kyoko/Eddy/Flo/Reed/Sandy × `corpus.tsv` 20文 (MODEL_DECISION.md と同じ) | 100 | 2270文字 | Japanese | CER |
| en-tts | `say` Samantha(US)/Daniel(GB)/Karen(AU)/Moira(IE)/Rishi(IN) × `corpus.en.tsv` 20文 | 100 | 935語 (数字を含む文を除くと745語) | English | WER |
| en-libri | LibriSpeech test-clean (CC BY 4.0) の全2620発話から id 順に等間隔で100 (実音声・読み上げ、計799秒) | 100 | 2111語 | English | WER |

- `corpus.en.tsv` は日本語と同じ構成: コマンド語4 (enter / new line / send / line break)、短文2、日常3、技術6、数字2、長文2、フィラー1
- WER の正規化: NFKC・小文字化、数字の桁区切り・ピリオド・アポストロフィを削除、他の記号は空白。**数字の表記の揺れ (3 PM / three p.m.、$15,000 / fifteen thousand dollars、30 / 30th) は正規化していない**ため「数字除くWER」も出した
- コマンドは id が cmd の発話を、アプリと同じ正規化 (空白・句読点除去・小文字化) で正解と完全一致したかで数える
- 計測は1モデルずつ順に実行 (並行なし)。ロード時間はページキャッシュが温まった状態。peak mem は `/usr/bin/time -l` の peak memory footprint

## 結果

vsBase / Base一致 は base-1.7b-8bit の出力との比較 (5bit が 8bit からどれだけ変わるかを見るため)。

### ja (data/tts、language=Japanese)

| label | CER | vsBase | Base一致 | コマンド | 中央値 | p90 | RTF | ロード | peak mem |
|---|---|---|---|---|---|---|---|---|---|
| **ja-8bit** | **11.9%** | 11.7% | 52/100 | 6/20 | 201ms | 533ms | 0.047 | 0.6s | 2.94GB |
| base-1.7b-8bit | 13.8% | 0.0% | 100/100 | 8/20 | 219ms | 525ms | 0.048 | 0.3s | 2.93GB |
| base-1.7b-5bit | 15.2% | 6.4% | 65/100 | 8/20 | 207ms | 471ms | 0.046 | 0.3s | 2.17GB |
| base-0.6b-8bit | 17.5% | 14.9% | 38/100 | 6/20 | 124ms | 328ms | 0.030 | 0.3s | 1.48GB |

区分ごとの CER (各区分 5話者分):

| 区分 | ja-8bit | base-1.7b-8bit | base-1.7b-5bit | base-0.6b-8bit |
|---|---|---|---|---|
| tech (技術用語6文) | 13.0% | 15.5% | 18.8% | 20.3% |
| num (数字2文) | 27.5% | 46.0% | 44.5% | 37.5% |
| long (長文2文) | 5.8% | 6.2% | 7.0% | 11.0% |
| daily (日常3文) | 6.8% | 6.1% | 5.8% | 10.3% |

ja-8bit の CER 11.9% は MODEL_DECISION.md (2026-09-30) の同じ音声・同じモデルの値と一致 (再現性の確認)。

### en-tts (data/tts-en、language=English)

| label | WER | 数字除くWER | CER | vsBase | Base一致 | コマンド | 中央値 | p90 | RTF | ロード | peak mem |
|---|---|---|---|---|---|---|---|---|---|---|---|
| base-1.7b-8bit | 7.0% | 2.4% | 6.1% | 0.0% | 100/100 | 19/20 | 173ms | 416ms | 0.058 | 0.6s | 2.79GB |
| base-1.7b-5bit | 7.7% | 2.4% | 5.5% | 1.7% | 94/100 | 19/20 | 154ms | 365ms | 0.052 | 0.4s | 2.03GB |
| base-0.6b-8bit | 6.7% | 2.0% | 6.2% | 3.7% | 80/100 | 20/20 | 105ms | 232ms | 0.035 | 0.3s | 1.36GB |
| ja-8bit | 7.7% | 2.7% | 6.8% | 3.3% | 86/100 | 19/20 | 174ms | 445ms | 0.062 | 0.5s | 2.79GB |

### en-libri (LibriSpeech test-clean 100発話、language=English)

| label | WER | 誤り語数 / 2111 | CER | vsBase | Base一致 | 中央値 | p90 | RTF | ロード | peak mem |
|---|---|---|---|---|---|---|---|---|---|---|
| base-1.7b-8bit | 2.0% | 43 | 0.9% | 0.0% | 100/100 | 294ms | 781ms | 0.048 | 0.6s | 3.20GB |
| base-1.7b-5bit | 2.1% | 45 | 1.0% | 0.2% | 92/100 | 272ms | 742ms | 0.045 | 0.5s | 2.44GB |
| base-0.6b-8bit | 2.5% | 53 | 1.2% | 1.4% | 73/100 | 166ms | 420ms | 0.027 | 0.3s | 1.67GB |
| ja-8bit | 1.8% | 38 | 1.0% | 1.1% | 83/100 | 311ms | 810ms | 0.050 | 0.6s | 3.20GB |

LibriSpeech の正解は数字も綴り (TWENTY 等)。モデルが数字で書いた分も誤りになる。

## 所見

### サンプル数とノイズ

- en-libri の誤り語数は 38〜53。誤りをポアソン的とみなすと ±6〜7語程度は揺れるため、**ja-8bit (38) と base-1.7b-8bit (43)・5bit (45) の差はノイズの範囲**。0.6B (53) はやや悪い傾向がある程度
- en-tts の「数字除くWER」は745語中 15〜20語の誤りで、4モデルの差 (2.0〜2.7%) は数語。誤りの大半は全モデル共通 (Tauri→Tori、Qwen3→Quan Three、"Got it"→Garcia 等の TTS 由来の聞き取りにくい語)。**en の精度でモデルを順位付けできるだけの差は出ていない**
- ja の CER 差 (11.9 vs 13.8%) は2270文字中 約43文字。うち num 区分 (数字の書き方) の寄与が大きく、下の「数字の書き方」のように実用上の差として説明できる
- レイテンシの差 (同一構成の ja-8bit と base-1.7b-8bit で ±5〜10%) は実行順・熱の揺れの範囲。0.6B の高速化と 5bit の数%の高速化は全セットで一貫している

### 数字の書き方 (ja)

元の Qwen (base-*) は「二千二十六年九月三十日の午前十時」「百五十万円」「午後三時」と**漢数字**で書く。ja-8bit は「2026年9月30日」「150万円」と**アラビア数字**で書き、正解表記に一致する。ja の CER 差の主因であり、文字入力としても ja-8bit が望ましい。ja の推奨を ja-8bit にする根拠として最も明確。

### コマンド語 (ja の「改行」「送信」がほぼ全滅する件)

| 語 | 結果 | 原因の分析 |
|---|---|---|
| 確定 | 全モデル 5/5 | - |
| エンター | Kyoko は全モデル正解。Eddy/Flo/Reed/Sandy は「N A」「N.」「あ、」 | **TTS 由来**。Eddy 等は多言語のノベルティ寄りの声で、カタカナ語の発音が崩れている。日本語の標準の声 Kyoko では正しく認識される |
| 改行 | **全モデル・全話者で「開業」** (一部「改良」) | **TTS ではなく同音異義語**。「改行」と「開業」はどちらも「かいぎょう」で音だけでは区別できず、単独発話では頻度の高い「開業」が選ばれる。Kyoko でも同じ。認識のヒント (context) に「音声コマンド: 確定、エンター、改行、送信」を渡しても ja-8bit・base-1.7b-8bit とも「開業」のまま (追加で確認) |
| 送信 | Kyoko は base-1.7b 系で「送信」、ja-8bit は「そうしん」(平仮名)。他の声は「そうしゅう」「そうし」 | 他の声は TTS の発音の崩れ (「そうしゅう」)。ja-8bit の平仮名は表記の選択で、context にコマンド語を渡すと 5話者中3話者で「送信」になった |

- コマンド語の正答数 (6〜8/20) の差は Kyoko 以外の TTS の崩れと同音異義語で決まっており、モデル選択の根拠にはならない
- 「改行」は実音声でも同じことが起こる見込みが高い (音が同じため)。モデルではなく音声コマンドの既定の言い方の問題として、rust/frontend 側で別途検討が要る (例: 既定の言い方の見直し。本作業では未対応。ASR 出力の置換はしない方針との整合も要確認)
- en のコマンド語 (enter / new line / send / line break) は 19〜20/20。唯一の誤りは Samantha の "Send"→"Sand" (3モデル共通、0.6B のみ正解)

### language の指定

asr-server の `language` クエリはプロンプトの `language {lang}<asr_text>` として渡り、効く。短い発話ほど強く引っ張られる (base-1.7b-8bit で確認):

| 音声 | language=Japanese | language=English |
|---|---|---|
| 送信 (Kyoko) | 送信。 | Soxin. |
| Send (Samantha) | 砂。 | Sand. |
| Let's meet at 10 AM… (Daniel) | レッツミートアット10 a.m. on the 30th… | Let's meet at 10 a.m. on the 30th… |
| 今日の午後3時から… (Kyoko) | 今日の午後三時から… | 今日の午後三時から… (長文は言語指定に関係なく音声の言語で出る) |

話す言語の設定が実際の発話と食い違うと、短い発話 (コマンド語) が別言語の表記になる。話す言語の設定を明示させる計画の方針と合う。

### 5bit vs 8bit (base-1.7b)

- en: 8bit と同一出力 94/100 (TTS)・92/100 (LibriSpeech)、WER 差は誤り語数で 0〜2語。サイズ -0.76GB (2.17→1.41GB)、peak mem -0.76GB、レイテンシ -5〜11%
- ja: 同一出力 65/100、CER +1.4pt (tech 区分で崩れが出る)。ja では 8bit との差が en より大きい
- 4bit (MODEL_DECISION.md でコマンド語・数字が崩れた) と違い、5bit で特有の崩れは見られなかった

### 量子化前 (bf16 → fp16 で読み込み) との差 (base-1.7b、2026-10-06 追加計測)

元の `Qwen/Qwen3-ASR-1.7B` (bf16、4.4GB) を fp16 で読み込んだもの (`base-1.7b-fp16`) を同じ音声で計測し、各 report.md の基準 (vsBase・Base一致) を fp16 にした。

| セット | 指標 | fp16 (元) | 8bit | 5bit | fp16 と同一出力 (8bit / 5bit) |
|---|---|---|---|---|---|
| ja | CER | 12.8% | 13.8% | 15.2% | 90/100 / 64/100 |
| en-tts | WER | 7.0% | 7.0% | 7.7% | 100/100 / 94/100 |
| en-libri | WER | 2.0% | 2.0% | 2.1% | 100/100 / 92/100 |

fp16 の peak mem は 8.5〜8.9GB、レイテンシ中央値は 8bit の約1.3倍。英語では 8bit は元のモデルと出力が全件一致し、量子化による劣化は見られない。

### language を省いた自動判定 (2026-10-06 追加計測)

`bench_python.py --language auto` (language=None) で 1.7B 8bit の2モデルを計測。

| セット | ja-8bit 指定 → auto | base-1.7b-8bit 指定 → auto |
|---|---|---|
| ja (CER) | 11.9% → 14.7% | 13.8% → 15.7% |
| en-tts (WER) | 7.7% → 35.8% | 7.0% → 7.2% |
| en-libri (WER) | 1.8% → 28.3% | 2.0% → 2.0% |

ja-8bit は自動判定で英語を日本語として書き起こすことが多く崩れる。base も ja では悪化する。アプリは話す言語を設定として持ち、常に language を明示する。

### 0.6B

- ja: CER 17.5%、tech・long で明確に悪い (TypeScript→「YPSCRPT」、長文 11.0%)。1.7B の代わりにはならない
- en: TTS では 1.7B と同等以上、LibriSpeech では誤り 1.2倍。速度 1.6〜1.8倍 (中央値 166 vs 294ms)、サイズ 0.84GB、peak mem 1.4〜1.7GB

## 推奨と並びの案

| 話す言語 | 計画の仮 | 計測からの案 | 備考 |
|---|---|---|---|
| ja | ja-8bit → base-1.7b-8bit → base-1.7b-5bit → base-0.6b-8bit | **同じ** | ja-8bit は CER・数字の表記とも最良。0.6B は精度が明確に下 |
| en | base-1.7b-8bit → base-1.7b-5bit → base-0.6b-8bit → ja-8bit | **base-1.7b-8bit (または 5bit) → base-1.7b-5bit → base-0.6b-8bit → ja-8bit** (ja-8bit の位置は根拠なし。下記) | |

en についての注記 (計測と仮の食い違い):
- **ja-8bit を en の最下位に置く計測上の根拠は無い**。LibriSpeech では最も低い WER、TTS では同等 (差はノイズの範囲)。「Qwen 公式を英語で推奨する」(計画の方針: 特化モデルが無ければ元のモデル) は精度ではなく方針・説明のしやすさの理由として残すのは妥当。ja-8bit を en の2番目にする案もありうる (日本語と英語の両方を話す人は ja-8bit 1つで足りる、という説明ができる)
- **8bit / 5bit**: en の精度差は計測で見えないため、サイズ (2.17 vs 1.41GB) と速度で 5bit を推奨にする案も成り立つ。ただし ja では 5bit の崩れが 8bit より大きく、英語話者が日本語を混ぜる場面の確認はしていない。計画どおり手元で触って決める (下の「手元で試す」)
- 0.6B は en で精度が近く速い。軽量を望む人向けの3番手として妥当

## 手元で試す (開発版アプリ)

`make up` (と `up-desktop`) は `MUKUCHI_MODEL_SNAPSHOT` (`Makefile` で `:=`) を asr-server の `--model` に渡す。コマンドラインの変数定義は `:=` より優先され、devShell 外からの実行 (`nix develop -c make ...` で再実行) でも `MAKEFLAGS` 経由で引き継がれることを確認した (`make` の外側 → `nix develop -c make` 内側で値が `/tmp/x-model` になる。指定しなければ dev データの ja-8bit のスナップショット)。

```bash
make up-desktop MUKUCHI_MODEL_SNAPSHOT=$PWD/spikes/asr-bench/models/base-1.7b-5bit
# make down してから別モデルで再起動。ディレクトリは絶対パスで渡す (process-compose の asr は apps/desktop で動くため)
```

- setup (モデル取得) は `MUKUCHI_MODEL` (既定の ja-8bit) のまま動き、指定したディレクトリには触れない
- 設定画面のモデル表示とは食い違う (CLAUDE.md の注記どおり)
- 英語で試すには話す言語 (未実装。現状アプリは language=Japanese 固定) が要る。それまでは asr-server 単体で確認する:

```bash
uv run --project apps/desktop/asr-server mukuchi-asr --port 18799 --model $PWD/spikes/asr-bench/models/base-1.7b-5bit
curl -s http://127.0.0.1:18799/health
curl -s -X POST "http://127.0.0.1:18799/transcribe?language=English" --data-binary @spikes/asr-bench/data/tts-en/tech02.samantha.wav
```

3モデルとも asr-server 単体で起動し /health と /transcribe (English / Japanese) が応答することを確認した (ロード 0.4〜0.7s、ログは `models/server-*.log`)。

## HF に上げる時の要件

`base-1.7b-8bit` は 2026-10-06 に `minimalcorp/Qwen3-ASR-1.7B-MLX-8bit` @`fc85f8e586506b91c707de9561998928f3f5d842` として公開済み (weights.safetensors の SHA-256 一致・取得対象の合計 2,174,372,462 B を確認)。5bit・0.6B は採用しないため公開しない。

既存の `minimalcorp/Qwen3-ASR-1.7B-JA-MLX-8bit` と同じ体裁にする。

1. リポジトリ名の案: `minimalcorp/Qwen3-ASR-1.7B-MLX-8bit`、`minimalcorp/Qwen3-ASR-1.7B-MLX-5bit`、`minimalcorp/Qwen3-ASR-0.6B-MLX-8bit` (名前は要決定)
2. `models/<id>/` の全ファイルに以下を加えてアップロード (`hf upload <repo> models/<id>`)
   - `LICENSE`: Apache-2.0 全文 (元の Qwen リポジトリに LICENSE ファイルが無いため同梱する。ja-8bit と同じ 11,358 B のもの)
   - `README.md` のメタデータ: `license: apache-2.0`、`base_model: Qwen/Qwen3-ASR-1.7B` (0.6B は `Qwen/Qwen3-ASR-0.6B`)、`base_model_relation: quantized`、`library_name: mlx-qwen3-asr`、`pipeline_tag: automatic-speech-recognition`、`language` (Qwen3-ASR の対応言語。少なくとも en・ja)、tags `mlx`・`qwen3-asr`・`8-bit`/`5-bit`
   - 本文: 元の revision、変更内容 (Apache-2.0 §4(b) の変更表示: 「MLX 形式に変換し全層 N bit (group 64、エンコーダ含む) に量子化。トークナイザ・config は無変更でコピー」)、使い方 (mlx-qwen3-asr 0.4.4、`language="English"` の例)、再現コマンドと weights.safetensors の SHA-256、この文書の評価結果
   - **5bit のみ**: 読み込みには `quantization_config.json` が必須で、mlx-qwen3-asr 0.4.4 の層ごとの判定は 5bit を認めず config の `bits` に頼っていること (他の変換器・読み込み器では読めない可能性) を書く
3. アップロード後、アプリのカタログ (`provisioning/models.rs`) にリポジトリIDと commit (revision) を固定して載せる (rust-engineer)。サイズは上の合計 + README の実サイズ

## 再現

```bash
cd spikes/asr-bench
scripts/make_tts.sh                       # data/tts (ja 100発話)
scripts/make_tts.sh --lang en             # data/tts-en (en 100発話)
scripts/prep_librispeech.sh               # data/libri (test-clean 346MB を取得し100発話を16kHz WAV に)

export HF_HOME=$PWD/models/hf             # 既存キャッシュを使わない (dev データ・~/.cache を汚さない)
uvx --from huggingface_hub hf download Qwen/Qwen3-ASR-1.7B --revision 7278e1e70fe206f11671096ffdd38061171dd6e5
uvx --from huggingface_hub hf download Qwen/Qwen3-ASR-0.6B --revision 5eb144179a02acc5e5ba31e748d22b0cf3e303b0
Q17=$HF_HOME/hub/models--Qwen--Qwen3-ASR-1.7B/snapshots/7278e1e70fe206f11671096ffdd38061171dd6e5
Q06=$HF_HOME/hub/models--Qwen--Qwen3-ASR-0.6B/snapshots/5eb144179a02acc5e5ba31e748d22b0cf3e303b0
C="uv run --project ../../apps/desktop/asr-server mukuchi-asr-convert"
$C --model $Q17 --bits 8 --out models/base-1.7b-8bit
$C --model $Q17 --bits 5 --out models/base-1.7b-5bit
$C --model $Q06 --bits 8 --out models/base-0.6b-8bit

# ja-8bit は make setup で dev データに取得済みのスナップショットを使う (別の場所なら MUKUCHI_JA8_SNAPSHOT で指定)
scripts/run_i18n.sh                       # → results-i18n/{ja,en-tts,en-libri}/report.md
```

`data/`・`models/`・`results*/` はコミットしない (gitignore 済み)。
