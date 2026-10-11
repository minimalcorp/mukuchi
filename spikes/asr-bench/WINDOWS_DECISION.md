# Windows の ASR 方式の検証 (Phase 0、途中経過)

2026-10-05 / Windows 11 (10.0.26200) / Core i9-12900KF (16C/24T) / RAM 64GB / RTX 3080 Ti 12GB (ドライバ 591.86) / llama.cpp b11408 (Windows ネイティブ)

## 結論 (暫定)

**A (llama.cpp `llama-server`) を採用する方向。** neosophie JA は `convert_hf_to_gguf.py` で変換でき、`context` も効く。PyTorch (B) は未計測 (A が基準を満たしたため、必要になるまで保留)。**話す言語ごとのモデル: ja = neosophie JA (ja-q8)、en = 元の Qwen3-ASR-1.7B (base-q8)** (下の「話す言語ごとのモデル」)。
未確認の項目は末尾の「未検証」を参照。

## 変換

```
convert_hf_to_gguf.py <neosophie/Qwen3-ASR-1.7B-JA> --outtype q8_0   → ja-q8_0.gguf   (1.75GiB)
convert_hf_to_gguf.py <同>   --outtype bf16 --mmproj                 → mmproj-ja-bf16.gguf (613MiB)
```
そのまま変換・読み込み・認識できた。取得量は約 2.4GiB (Mac の MLX 8bit の 2.2GB と同程度)。

## 結果 (Haruka TTS 20文 × 話速 5段階 = 100発話、Q8_0 + mmproj BF16、`ngl 99`)

| 構成 | context | CER | 中央値 | p90 | RTF | RSS ピーク | ロード |
|---|---|---|---|---|---|---|---|
| CUDA 13.4 | なし | 8.15% | 113ms | 150ms | 0.027 | 3.4GB | 1.8s |
| CUDA 13.4 | あり | 6.96% | 111ms | 155〜168ms | 0.027 | 3.8GB | 1.7s |
| CUDA 13.4 | あり + 言語 prefill | 6.83% | 100ms | 143ms | 0.024 | 3.8GB | 1.8s |
| CUDA 13.4 (LLM を bf16) | あり | 6.43% | 143ms | 204ms | 0.035 | 5.3GB | 2.4s |
| Vulkan | なし | 8.15% | 119ms | 269ms | 0.038 | 3.0GB | 4.0s |
| CPU のみ (ngl 0、スレッド既定) | なし | 8.15% | 911ms | 1283ms | 0.221 | 4.1GB | 1.8s |
| CPU のみ (8 スレッド) | あり | 6.61% | 999ms | 1351ms | 0.235 | 4.4GB | 1.4s |
| CPU のみ (16 スレッド) | あり | 6.61% | 910ms | 1291ms | 0.217 | 4.4GB | 1.4s |

- VRAM (CUDA、ctx 4096): ピーク約 5.3GB (nvidia-smi の使用量 6056MiB − 起動前 742MiB)
- CER は音声が違う (Mac は say の 5 話者、こちらは Haruka 1 話者) ため Mac の 11.0% と直接比べられない。**同一音声での Q8_0 と bf16 の差は 0.5pt** (6.96% vs 6.43%)
- 誤りは TTS 由来の固有名詞 (Rust→ラスト、GitHub→自宅)・表記ゆれ (もと/元)・コマンド語 (「改行」「送信」を低速 TTS で誤認: 100発話中 2〜3) 。context で Qwen3 の表記などは改善する
- 無音・雑音・ハム音・クリック音 (6 件): すべて本文が空 (`language None/Chinese<asr_text>` のみ)。ハルシネーションなし (VAD 通過後の実音声ではないため、`filters.py` 相当は引き続き必要)
- 言語 prefill (`language Japanese<asr_text>`) の効果はごく小さい (CER 6.96→6.83%)。ただし言語判定の揺れ対策に使える

## 採用の基準 (案) との照合

| 基準 | 結果 |
|---|---|
| CER が Mac の 8bit 比 +1pt 以内 | 同一音声の bf16 比で +0.5pt。Mac 8bit との直接比較はできない (話者が違う) |
| GPU で p90 ≤ 1s | CUDA 150〜170ms、Vulkan 270ms。達成 |
| `context` が効く | 効く (system メッセージ) |
| CPU のみで p90 ≤ 2s | i9-12900KF で 1.3s。達成 (弱い CPU は未計測。目安扱い) |

## 同梱物の大きさ (展開後 / zip)

| 内容 | 展開後 | zip |
|---|---|---|
| CUDA 13.4 版 llama-server (+cudart 13.4) | 712MB (+ cudart 523MB。重複を除いて要確認) | 146MB + 404MB |
| Vulkan 版 | 91MB | 32MB |
| CPU 版 | 48MB | 18MB |

CUDA 版は cudart を含めると大きい。Vulkan 版は GPU ベンダーを問わず、3080 Ti では CUDA の p90 の約 1.7 倍で十分速い。**標準を Vulkan、NVIDIA 向けの CUDA は任意の追加取得** とするのが現実的。

## CPU のみの扱い (追加調査、2026-10-05)

i9-12900KF を、使うコアを絞って擬似的に弱い CPU にして測った (`-C` でコアを固定、context あり、CER は全て 6.6〜6.8% で同じ。平均発話 4.4 秒・最長 14.9 秒の 100 発話)。

| 構成 | 近い実 CPU (PassMark シングル) | 中央値 | p90 | RTF |
|---|---|---|---|---|
| P コア 8 + E コア (全部、16 スレッド) | i9-12900KF (4118) | 910ms | 1291ms | 0.22 |
| P コア 6 (HT なし) | i5-12400 (3466)、Ryzen 5 5600 (3253) | 1026ms | 1484ms | 0.25 |
| P コア 4 | i3 / 4 コア級 | 1319ms | 1860ms | 0.32 |
| E コア 8 のみ | 薄型ノートの U/P シリーズに近い (※) | 1829ms | 2683ms | 0.44 |
| P コア 2 | 2 コア級 | 2345ms | 3354ms | 0.56 |

※ i5-1235U (3045)・Core Ultra 5 125U (3227)・Ryzen 5 7530U (2971) は 2P+8E 前後で、E コア 8 と P コア 2〜4 の間。Ryzen 5 5500U (2387) はそれより遅い。実測ではなく推定。

- 主流のミドル (6 コア・シングル 3250〜3470) で **中央値 約1.0s、p90 約1.5s**。上位機とほぼ同じで、1 秒には届かない
- ノート (薄型) は 2 秒前後が中心になる見込み。バッテリー駆動・省電力設定でさらに遅くなりうる (未計測)
- 発話が長いほど線形に遅くなる (RTF 0.25 なら 15 秒の発話で約 3.7 秒)
- 参考: Steam Hardware Survey (2026年6〜8月) の GPU 上位は RTX 3060 / RTX 4060 (Laptop) / RTX 4060 で、GTX 1650 も 2.7%。ミドル GPU は GPU 経路 (Vulkan/CUDA) で動かせる

### 判断

CPU のみは **対応外 (動くが推奨しない)** とする。基準 (p90 ≤ 2s) を満たすのは 6 コア以上のデスクトップ級に限られ、1 秒以内は上位機でも満たさない。Mac (中央値 213ms) との体感差が大きい。
- GPU (Vulkan 以上、独立 GPU) を必須の推奨とし、LP には「CPU のみは非推奨」と明記する
- GPU が見つからない環境でも起動はできるが、セットアップで警告を出す (ブロックはしない)
- スペック表ではなく、セットアップの動作確認 (verify.wav) で実測した遅延を使い、閾値 (例: 中央値 > 700ms) を超えたら「この PC では遅く、推奨しません」と案内する案

GPU 側 (推定): 認識は主にメモリ帯域と演算に比例する。3080 Ti (912GB/s) の中央値 111ms に対し、RTX 3060 (360GB/s)・4060 (272GB/s) は 2〜4 倍で約 250〜450ms と見込む。実測していない。統合 GPU (Intel Iris Xe、Radeon 680M 等) は未検証のため、動作確認済みの構成から除く。

## GPU の有無の判別 (追加調査、2026-10-05)

目的: 「CPU のみ」の環境だけを確実に見分け、GPU を積む環境には余計な確認を出さない。

### 実測 (RTX 3080 Ti の本機。GPU なしは環境変数で擬似再現)

| 方法 | GPU あり | GPU なし (擬似) |
|---|---|---|
| `llama-server --list-devices` (Vulkan 版) | `Vulkan0: NVIDIA GeForce RTX 3080 Ti (12084 MiB, 11316 MiB free)` | `VK_DRIVER_FILES` を存在しないファイルにすると `(none)` |
| 同 (CUDA 版) | `CUDA0: ... (12287 MiB ...)` | `CUDA_VISIBLE_DEVICES=-1` で `(none)` |
| 同 (CPU 版) | `(none)` | `(none)` |
| WMI `Win32_VideoController` | 名前・PNPDeviceID は取れる。**`AdapterRAM` は 4,293,918,720 (32bit の上限)**。12GB の GPU が約 4GB と出る | - |

- 判別の正は **実際に推論で使う経路の列挙**。Vulkan 版で `--list-devices` が `(none)` なら、その PC では GPU 経路が使えない
- llama.cpp の Vulkan バックエンドは、デバイスの種類 (独立 / 内蔵 `IntegratedGpu`)・UMA を自前で持つ (`ggml-vulkan.cpp`)。ソフトウェアレンダラー (CPU エミュレーション) は一覧に出ない前提 (`eDiscreteGpu` / `eIntegratedGpu` のみ採用)
- DXGI (`EnumAdapters1`) は `DXGI_ADAPTER_FLAG_SOFTWARE` で "Microsoft Basic Render Driver" (VendorId 0x1414) を除ける。独立 / 内蔵の区別は DXGI の `DXGI_ADAPTER_DESC2` にはなく、D3D12 の `D3D12_FEATURE_DATA_ARCHITECTURE.UMA` を使う ([MS Learn](https://learn.microsoft.com/en-us/windows/win32/api/d3d12/ns-d3d12-d3d12_feature_data_architecture))。ダウンロード前に判定できる利点がある
- ブラウザ (LP) からの判別は不確実: Chromium 系は WebGL の `UNMASKED_RENDERER_WEBGL` を正確に返すが、Firefox は GPU を大まかな族に丸める ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/WEBGL_debug_renderer_info))。WebGPU の `isFallbackAdapter` は現状ほぼ常に false。ブラウザのハードウェアアクセラレーション無効や、ノートの Optimus (ブラウザが内蔵 GPU を使う) で誤判定する。**LP では判別せず、静的な要件の記載にとどめる**

### 設計への含意

1. 判定は 2 段階にする。(a) DXGI でダウンロード前に粗く見る (ソフトウェア以外のアダプターの有無、独立/内蔵、VRAM)。(b) 小さい Vulkan 版 (zip 31MB) を取得して `--list-devices` で確定。モデル (約 2.4GB) の取得はこの後
2. 「GPU がない」と「GPU はあるが Vulkan が使えない (古いドライバー等)」は **別の案内にする**。DXGI にハード GPU がいて Vulkan が `(none)` ならドライバー更新の案内。両方 `(none)` の時だけ CPU の同意ダイアログを出す
3. CPU 実行は **同意した場合のみ**。同意の記録を設定に持つ。同意後に CPU 版 (18MB) を使う
4. 独立 GPU と内蔵 GPU が両方ある PC (ノート) では、`--device VulkanN` で推論に使うデバイスを 1 つに固定する (指定しないと複数デバイスに分割されうる)。独立 GPU を優先
5. 内蔵 GPU のみの PC: 速度は未検証 (本機に内蔵 GPU なし)。GPU として扱うが、セットアップの動作確認で実測した遅延が閾値を超えたら通知する安全網を置く
6. 誤判定の逃げ道: ダイアログに「再検出」とドライバー更新の案内を置く。リモートデスクトップ・VM では GPU が見えないことがあり、未検証

### 未検証

- 内蔵 GPU (Intel Iris Xe、Radeon 680M 等) の速度と、Vulkan の列挙結果
- 独立 + 内蔵のハイブリッド環境での列挙順と `--device` の挙動
- リモートデスクトップ / Hyper-V / VM での列挙結果
- DXGI の実装 (Rust `windows` crate)。本機では Vulkan / CUDA の列挙のみ実測した

## 話す言語ごとのモデル (追加検証、2026-10-08)

Mac の方針 (docs/plans/i18n-plan.md「話す言語ごとの推奨モデル」、MODEL_DECISION_I18N.md) に合わせる: **その言語に特化したモデルがあればそれ、なければ追加学習なしの元のモデル。精度が同程度なら元のモデル**。同じ指標 (ja=CER、en=WER・数字除くWER) と同じ音声の種類 (TTS と LibriSpeech test-clean 100発話) で、Windows (CUDA、`language` を prefill で明示、context なし) で測った。

候補 (全て LLM は Q8_0):
- `ja-q8`: `neosophie/Qwen3-ASR-1.7B-JA` @987bda16… を自前変換 (1,834,422,688 B)
- `base-q8`: `Qwen/Qwen3-ASR-1.7B` @7278e1e7… を自前変換 (2,165,035,008 B)
- `ggml-org`: `ggml-org/Qwen3-ASR-1.7B-GGUF` @36a67868… の Q8_0 (2,165,034,944 B。公式の変換物)
- mmproj: BF16 (641,774,016 B) と Q8_0 (355,709,344〜760 B) を比較

### 結果 (誤り数 / 全体。CUDA、RTX 3080 Ti)

| セット | 指標 | ja-q8 | base-q8 (自前) | ggml-org (公式) |
|---|---|---|---|---|
| ja (Haruka TTS 100発話、2270字) | CER | **8.4%** (191字) | 11.6% (264字) | 11.7% (265字) |
| en-tts (Zira TTS 100発話、935語) | WER | 3.3% (31語) | 5.4% (50語) | 5.2% (49語) |
| en-tts | 数字除くWER | 1.07% | 1.34% | 1.34% |
| en-libri (LibriSpeech 100発話、2111語) | WER | 2.1% (44語) | 2.2% (46語) | 2.0% (43語) |
| 中央値 / p90 (ja・en とも) | | 93〜139 / 140〜313ms | 同 | 同 |

- **ja**: ja-q8 が明確に良い。元の Qwen は数字を漢数字で書く (「二千二十六年九月三十日の午前十時」「百五十万円」)。ja-q8 は「2026年9月30日」「150万円」。Mac と同じ傾向で、**ja の推奨は ja-q8**
- **en**: LibriSpeech は 44 / 46 / 43 語で**ノイズの範囲** (Mac と同じ結論)。TTS の差 (31 vs 50 語) は数字の書き方が主因で、ja-q8 は `$15,000`、元の Qwen は `fifteen thousand dollars` と書く (正解表記は前者)。数字を除くと 1.07% vs 1.34% (約 2 語)。**Mac の方針どおり en の推奨は元の Qwen (base-q8)**。ja-q8 は en でも使える (en の 2 番目)
- **自前変換と公式の変換物は同等** (LibriSpeech 46 vs 43 語、en-tts 50 vs 49 語、ja 264 vs 265 字)。ファイルは 64 バイト差 (メタデータ)。自前変換で `minimalcorp/` に置いても、公式を revision 固定で使っても精度は変わらない
- **mmproj Q8_0 は BF16 と同等**: base (公式) で LibriSpeech 2.08% vs 2.04%、en-tts・ja はどちらも同値、ja-q8 で ja CER 8.15%・LibriSpeech 1.94% (BF16 と同等)。**mmproj は Q8_0 を採用でき、0.29GB 小さくなる**
- 取得量 (LLM + mmproj Q8_0): **ja = 2,190,132,448 B (約 2.19GB。Mac の ja-8bit 2.19GB と同じ)、en = 2,520,744,352 B (約 2.52GB)**。HF の tree API の値ではなくローカルのファイルの合計 (公開後に確かめて直す)
- 速度・VRAM は 3 モデルとも同じ (中央値 90〜140ms)

### language の指定とハルシネーション (重要)

- 言語を**指定しない**時: ja-q8 は本機の ja・en・LibriSpeech とも精度が変わらない (Mac の MLX では en が崩れたが、llama.cpp 経路では崩れなかった)。それでも**常に `language` を明示する** (短い発話の言語の引っ張りが Mac と同じように出るため。アプリの方針と同じ)
- 3 秒のデジタル無音・雑音・ハム・クリックを入れた時 (VAD を通さない最悪の入力):
  - ja-q8 + 日本語指定: 空 または「うん。」「あ、」程度
  - **base-q8 + 日本語指定: 無音で「自分の心に」を 256 トークン上限まで繰り返す** (暴走)。英語指定: 「The first was the first of the three.」、言語なし: 中国語の文章
  - ja-q8 + 英語指定: 「I'm going to go to the bathroom.」(雑音)
- 対策 (Windows の実装の必須項目): ① VAD を通った音声だけ送る (今の設計どおり) ② **`max_tokens` を音声の長さから見積もる** (暴走の上限。例: 秒数 × 想定の最大文字数 + 余裕) ③ `filters.py` に加えて**繰り返しの検出**を Rust に実装 ④ en の定型ハルシネーション (「Thank you for watching」等。Mac の `filters.py` は日本語のみ) は Mac と共通の課題として別途
- 元の Qwen は無音で崩れやすい。VAD の既定の感度で短い無音が漏れる場合の影響は、実機の通しで確かめる (Phase 7)

### HF へのアップロード (2026-10-08、public)

アップロードは Claude Code が、利用者がログイン済みの認証情報で実行した (トークンは扱っていない)。`hf auth whoami` で `minimalcorp` 所属を確認。SHA-256・サイズは手元のファイルと**全て一致**。ユーザーの確認後に **public にした** (匿名で API が読めることを確認。revision は変わらず)。

| リポジトリ | revision (public) | LLM | mmproj |
|---|---|---|---|
| `minimalcorp/Qwen3-ASR-1.7B-JA-GGUF` | `7017bd6ff5156a4e9ad32997d2a9e38eedcb370e` | `Qwen3-ASR-1.7B-JA-Q8_0.gguf` 1,834,422,688 B | `mmproj-Qwen3-ASR-1.7B-JA-Q8_0.gguf` 355,709,760 B |
| `minimalcorp/Qwen3-ASR-1.7B-GGUF` | `bf5c671638392f5d963391fb56765771def5fdfe` | `Qwen3-ASR-1.7B-Q8_0.gguf` 2,165,035,008 B | `mmproj-Qwen3-ASR-1.7B-Q8_0.gguf` 355,709,376 B |

取得量: ja 2,190,132,448 B、en 2,520,744,384 B (LLM + mmproj。LICENSE・README を除く)。公開後に確認した値で、`CATALOG` に入れてよい (カードを直すと変わるため、直した場合は取り直す)。

## 未検証

- 自分の声 (マイク) での認識、PyTorch (B) の同一音声比較
- コールドスタート (ディスクキャッシュなし) のロード時間
- AMD・Intel GPU、統合 GPU、弱い CPU
- llama-server の `/transcribe` 相当の API 形 (今は `/v1/chat/completions` + `input_audio`)。長い発話 (30 秒超) の挙動
- CUDA 版の Vulkan 版に対する実利、cudart の最小構成 (必要な DLL のみ)
- 並行リクエスト、プロセスの常駐時のメモリ増加 (数時間)

## 再現

`windows/` の bench.py (パスは `C:\mukuchi-spike` 前提)、tts.ps1 (Haruka で 100 発話)。llama.cpp は b11408 の公式バイナリ。
