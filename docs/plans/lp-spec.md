# LP (apps/web) 仕様

デザインの正: Claude Design handoff `docs/design/lp-handoff/project/mukuchi LP.dc.html` (git管理外)。PC 版は「1b LP」、スマホ版は「2a SP」。以下はデザインから変える点・確定値 (2026-09-30)。

## 配布

- ダウンロード先: GitHub Releases の最新版を指す固定 URL `https://github.com/minimalcorp/mukuchi/releases/latest/download/mukuchi_aarch64.dmg`
  - リリース用ワークフローは版番号なしの `mukuchi_aarch64.dmg` (と `.sha256`) だけを添付する
- GitHub: `https://github.com/minimalcorp/mukuchi`

## 数値・文言 (実装と実測を正とする)

| 項目 | デザイン | LP に書く値 | 根拠 |
|---|---|---|---|
| dmg のサイズ | 48 MB | 36 MB | v0.1.0 の署名・公証済み dmg (35.95 MB) |
| OS | macOS 14 Sonoma 以降 | macOS 13 Ventura 以降 | `LSMinimumSystemVersion` 13.0 (SMAppService のため) |
| チップ | Apple Silicon (M1 以降) | Apple Silicon (M1 以降)。動作確認: M1 Max・M3 Pro | MLX が Apple Silicon 専用 |
| メモリ | 16 GB 以上を推奨 | 16 GB 以上を推奨 | 16 GB 未満は未確認 |
| ストレージ | 空き容量 5 GB 以上 | 空き容量 6 GB 以上 | 導入後の実測 4.4 GB (モデル 3.8 GB・実行環境 約 0.6 GB) + アプリ 66 MB + 余裕 |
| モデル容量 | 約 2.4 GB | 約 2.2 GB | 既定のモデル (`minimalcorp/Qwen3-ASR-1.7B-JA-MLX-8bit`、2,185,804,096 B)。初回セットアップはこれだけを取得する (bf16 版 約 4.1 GB は設定から任意で取得) |
| 標準モデル | Qwen3-ASR 1.7B (日本語) | 同左 | |
| バージョン | v0.1.0 | v0.1.0 | |
| 価格 | 無料 | 無料 | |
| 通信 | 「モデルとアップデートの取得以外に通信しません」 | 「モデルの取得以外に通信しません」 | 自動アップデートは未実装 |

数値・版・URL は `apps/web/app/lib/site.ts` などの1か所に定数としてまとめ、リリースのたびにそこだけ直せばよいようにする。

## 音声コマンド (アプリの既定値を正とする)

| 言い方 | キー |
|---|---|
| 確定 / エンター | Enter |
| 改行 | ⇧ + Enter |
| 送信 | ⌘ + Enter |

- デザインの「取り消し (⌘ + Z)」「すべて選択 (⌘ + A)」は載せない (アプリが未対応)
- 特長 03 の本文「「改行」「送信」「取り消し」などの言葉を…」は「「確定」「改行」「送信」などの言葉を…」に直す
- デモの「「送信」→ ⌘ + Enter」はそのまま

## その他

- OS・CPU の判定 (Apple Silicon / Intel / 判定不可 / Windows / Linux / スマホ) とボタンの出し分けはデザインどおり。Chrome・Edge は `navigator.userAgentData.getHighEntropyValues(["architecture"])` で判定する
- スマホ版の「URL をコピー」「共有」(Web Share API) はデザインどおり
- デザインの Tweaks (状態の切り替え) は本番では出さない。開発時の確認用にクエリパラメータなどで切り替えられるようにする
- 計測は GA4 (測定 ID は `app/lib/site.ts`)。gtag は本番ビルドだけが読み込み、`mukuchi.minimalcorp.com` で開いた時だけ送る (dev・`vite preview`・本番以外のステージは送らない)。同意バナーは出さず、フッターに外部送信の表記と Google の説明へのリンクを置く
  - イベント: `file_download` (ダウンロードボタン。dmg は拡張計測機能の対象外のため自前で送る)・`github_click`・`share` (`method`: `copy` / `native`)。押した場所は `cta_location` (`header` / `hero` / `final` / `footer`)。管理画面でカスタムディメンションに登録しないとレポートに出ない
  - 拡張計測機能の「ブラウザの履歴イベントに基づくページの変更」はオンのまま (アンカーの移動・戻る・URL の変わらない replaceState では page_view が増えないことを確認済み。React Router の画面遷移を足した時に必要)
  - 実際のダウンロード数は GitHub Releases の `download_count` を正とする (`gh api repos/minimalcorp/mukuchi/releases`)。GA の数字は流入元・押した割合を見るためのもの
