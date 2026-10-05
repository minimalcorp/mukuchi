# LP (apps/web) 仕様

デザインの正: Claude Design handoff `docs/design/lp-handoff/project/mukuchi LP v2.dc.html` (git管理外)。PC 版は「1a PC 1280px」、スマホ版は「1b SP 390px」(2026-10-02、入力モード・ショートカットに対応した版。旧版は `mukuchi LP.dc.html`)。上部の修正表・要約カードは意図のメモで、LP には載せない。以下はデザインから変える点・確定値 (2026-09-30、2026-10-02 更新)。

## 配布

- ダウンロード先: GitHub Releases の最新版を指す固定 URL `https://github.com/minimalcorp/mukuchi/releases/latest/download/mukuchi_aarch64.dmg`
  - リリース用ワークフローは版番号なしの `mukuchi_aarch64.dmg` (と `.sha256`) だけを添付する
- GitHub: `https://github.com/minimalcorp/mukuchi`

## 数値・文言 (実装と実測を正とする)

| 項目 | デザイン | LP に書く値 | 根拠 |
|---|---|---|---|
| dmg のサイズ | 約 36 MB | 36 MB (セットアップの手順では「約 36 MB」) | v0.1.0 の署名・公証済み dmg (35.95 MB)、v0.1.3 は 36.21 MB |
| OS | macOS 13 Ventura 以降 | 同左 | `LSMinimumSystemVersion` 13.0 (SMAppService のため) |
| チップ | Apple Silicon (M1 以降)。別の行に動作確認: M1 Max・M3 Pro | 同左 | MLX が Apple Silicon 専用 |
| メモリ | 16 GB 以上を推奨 | 16 GB 以上を推奨 | 16 GB 未満は未確認 |
| ストレージ | 空き容量 6 GB 以上 | 同左 | 導入後の実測 4.4 GB (モデル 3.8 GB・実行環境 約 0.6 GB) + アプリ 66 MB + 余裕 |
| モデル容量 | 約 2.2 GB | 約 2.2 GB | 既定のモデル (`minimalcorp/Qwen3-ASR-1.7B-JA-MLX-8bit`、2,185,804,096 B)。初回セットアップはこれだけを取得する (bf16 版は新規には選べない。既に導入済みの人のみ設定に出る) |
| 標準モデル | Qwen3-ASR 1.7B（日本語・約 2.2 GB） | 同左 | モデル名・容量は `site.ts` の定数から組み立てる |
| バージョン | v0.1.x | desktop の最新の版 | ビルド時に `apps/desktop/src-tauri/tauri.conf.json` から読む。desktop のリリースで LP も配信し直す (docs/release.md) |
| 価格 | 無料 | 無料 | |
| 通信 | 「音声認識モデルのダウンロード以外に通信しません」 | 「音声認識モデルのダウンロードと、アップデートの確認・ダウンロード以外に通信しません。アップデートの自動確認は設定で止められます。」 | desktop v0.3.0 で自動アップデート (GitHub Releases の確認・取得) を入れたため。自動確認は `Settings.autoCheckUpdates` で止められる (docs/architecture.md「アップデート」) |
| ショートカット | ⌥Space | ⌥Space | desktop の `Settings.shortcut` の既定 (`Alt+Space`) |
| 入力モード節の lead | 「モードは初回セットアップで選びます。」 | 「モードは初回セットアップで選び、あとから設定で変更できます。」 | 設定 > 音声入力 でも変更できる (docs/architecture.md「入力モード」) |

数値・版・URL は `apps/web/app/lib/site.ts` などの1か所に定数としてまとめる。版は自動で合わせ、それ以外は変わった時にそこだけ直せばよいようにする。

## 音声コマンド (アプリの既定値を正とする)

| 言い方 | キー |
|---|---|
| 確定 / エンター | Enter |
| 改行 | ⇧ + Enter |
| 送信 | ⌘ + Enter |

- 「取り消し (⌘ + Z)」「すべて選択 (⌘ + A)」は載せない (アプリが未対応)。v2 のデザインは対応済み
- デモの「「送信」→ ⌘ + Enter」はそのまま

## その他

- OS・CPU の判定 (Apple Silicon / Intel / 判定不可 / Windows / Linux / スマホ) とボタンの出し分けはデザインどおり。Chrome・Edge は `navigator.userAgentData.getHighEntropyValues(["architecture"])` で判定する
- スマホ版の「URL をコピー」「共有」(Web Share API) はデザインどおり
- デザインの Tweaks (状態の切り替え) は本番では出さない。開発時の確認用にクエリパラメータで切り替えられるようにする (`?os=mac-arm|mac-unknown|mac-intel|windows|linux|mobile`、ヒーローのデモのモードの固定 `?heroMode=always|once`)
- ヒーローのデモは 2 つのモードの流れを最後まで進むたびに交互に再生し、タブを押すとそのモードに固定する。動きを減らす設定では入力まで済んだ場面で止める (タブでモードは替えられる)
- 計測は GA4 (測定 ID は `app/lib/site.ts`)。gtag は本番ビルドだけが読み込み、`mukuchi.minimalcorp.com` で開いた時だけ送る (dev・`vite preview`・本番以外のステージは送らない)。同意バナーは出さず、フッターに外部送信の表記と Google の説明へのリンクを置く
  - イベント: `file_download` (ダウンロードボタン。dmg は拡張計測機能の対象外のため自前で送る)・`github_click`・`share` (`method`: `copy` / `native`)。押した場所は `cta_location` (`header` / `hero` / `final` / `footer`)。管理画面でカスタムディメンションに登録しないとレポートに出ない
  - 拡張計測機能の「ブラウザの履歴イベントに基づくページの変更」はオンのまま (アンカーの移動・戻る・URL の変わらない replaceState では page_view が増えないことを確認済み。React Router の画面遷移を足した時に必要)
  - 実際のダウンロード数は GitHub Releases の `download_count` を正とする (`gh api repos/minimalcorp/mukuchi/releases`)。GA の数字は流入元・押した割合を見るためのもの
