# LP (apps/web) 仕様

デザインの正: Claude Design handoff `docs/design/lp-handoff/project/mukuchi LP v2.dc.html` (git管理外)。PC 版は「1a PC 1280px」、スマホ版は「1b SP 390px」(2026-10-02、入力モード・ショートカットに対応した版。旧版は `mukuchi LP.dc.html`)。上部の修正表・要約カードは意図のメモで、LP には載せない。以下はデザインから変える点・確定値 (2026-09-30、2026-10-02 更新)。

## 配布

- ダウンロード先: GitHub Releases の最新版を指す固定 URL (`site.ts` の `DOWNLOADS`)
  - Mac: `https://github.com/minimalcorp/mukuchi/releases/latest/download/mukuchi_aarch64.dmg`
  - Windows: `https://github.com/minimalcorp/mukuchi/releases/latest/download/mukuchi_x64-setup.exe` (署名なし。docs/release.md の「Windows」)
  - リリース用ワークフローは版番号なしの成果物 (と `.sha256`) を添付する
- Windows 版の公開: `site.ts` の `WINDOWS_AVAILABLE` (既定 false)。Windows の Release が公開されて exe が実在してから true にして deploy する (リンク切れのボタンを出さない)。false の間は Windows の主ボタンを「準備中」にし、Windows のインストーラーへのリンクをどこにも出さない。OS 中立の文言はこの値に関係なく出す
- GitHub: `https://github.com/minimalcorp/mukuchi`

## 数値・文言 (実装と実測を正とする)

| 項目 | デザイン | LP に書く値 | 根拠 |
|---|---|---|---|
| dmg のサイズ | 約 36 MB | 36 MB (セットアップの手順では「約 36 MB」) | v0.1.0 の署名・公証済み dmg (35.95 MB)、v0.1.3 は 36.21 MB |
| Windows のインストーラーのサイズ | - | 29 MB (`NSIS_SIZE_MB`) | 実測 28,864,743 B |
| Windows の OS | - | Windows 11 (64 bit・x64)。ARM は非対応 | docs/plans/windows-plan.md §2 |
| Windows の GPU・CPU | - | GPU 推奨 (Vulkan 対応、VRAM 使用量 約 3 GB は実測)。CPU のみは非推奨 (同意の上で使える。1〜3 秒以上の目安)。動作確認は RTX 3080 Ti / Core i9-12900KF のみ、AMD・Intel の GPU・内蔵 GPU のみ・弱い CPU は「未確認」と書く。LP はブラウザから GPU を判定しない | windows-plan.md §5.1・§12 |
| Windows のメモリ・ストレージ | - | メモリは「未確認 (動作確認した PC は 64 GB)」、ストレージは「空き容量 6 GB 以上 (目安)」 | 実測していない値は目安・未確認と書き分ける |
| Windows の署名 | - | なし。初回に SmartScreen の警告 (「詳細情報」→「実行」)。Smart App Control が有効な PC では使えない (回避手段なし)。Code signing policy ページは作らない | docs/release.md「署名なし (SmartScreen)」 |
| OS | macOS 13 Ventura 以降 | 同左 | `LSMinimumSystemVersion` 13.0 (SMAppService のため) |
| チップ | Apple Silicon (M1 以降)。別の行に動作確認: M1 Max・M3 Pro | 同左 | MLX が Apple Silicon 専用 |
| メモリ | 16 GB 以上を推奨 | 16 GB 以上を推奨 | 16 GB 未満は未確認 |
| ストレージ | 空き容量 6 GB 以上 | 同左 | 導入後の実測 4.4 GB (モデル 3.8 GB・実行環境 約 0.6 GB) + アプリ 66 MB + 余裕 |
| モデル容量 | 約 2.2 GB | 約 2.2 GB | 既定のモデル (`minimalcorp/Qwen3-ASR-1.7B-JA-MLX-8bit`、2,185,804,096 B)。初回セットアップはこれだけを取得する (bf16 版は新規には選べない。既に導入済みの人のみ設定に出る) |
| 標準モデル | Qwen3-ASR 1.7B（日本語・約 2.2 GB） | 同左 | モデル名・容量は `site.ts` の定数から組み立てる |
| バージョン | v0.1.x | desktop の最新の版 | ビルド時に `apps/desktop/src-tauri/tauri.conf.json` から読む。desktop のリリースで LP も配信し直す (docs/release.md) |
| 価格 | 無料 | 無料 | |
| 通信 | 「音声認識モデルのダウンロード以外に通信しません」 | 「音声認識モデルのダウンロードと、アップデートの確認・ダウンロード以外に通信しません。アップデートの自動確認は設定で止められます。」 | desktop v0.3.0 で自動アップデート (GitHub Releases の確認・取得) を入れたため。自動確認は `Settings.autoCheckUpdates` で止められる (docs/architecture.md「アップデート」) |
| ショートカット | ⌥Space | Mac ⌥Space / Windows Alt+Space (`site.ts` の `KEYS`) | desktop の `Settings.shortcut` の既定 (`Alt+Space`、両 OS 共通) |
| 常駐場所 | メニューバー | Mac メニューバー / Windows タスクトレイ | desktop の表示 |
| 入力モード節の lead | 「モードは初回セットアップで選びます。」 | 「モードは初回セットアップで選び、あとから設定で変更できます。」 | 設定 > 音声入力 でも変更できる (docs/architecture.md「入力モード」) |

数値・版・URL は `apps/web/app/lib/site.ts` などの1か所に定数としてまとめる。版は自動で合わせ、それ以外は変わった時にそこだけ直せばよいようにする。

## 言語 (2026-10-06)

- `/` = 日本語、`/en/` = 英語 (両方を事前生成)。方針は [i18n-plan.md](i18n-plan.md) の「web (LP)」。文言は `apps/web/app/i18n/{ja,en}.ts` (ja が型の正)、数値・版・URL は `site.ts`
- モデルの名前・容量はページの言語を話す人の推奨モデルを OS × 言語で持つ (`site.ts` の `MODELS`): Mac ja = `ja-8bit` (2,185,804,096 B → 約 2.2 GB)、Mac en = `base-1.7b-8bit` (2,174,372,462 B → about 2.2 GB)、Windows ja = `ja-gguf` (暫定 2,190,132,448 B → 約 2.2 GB)、Windows en = `base-gguf` (暫定 2,520,744,352 B → about 2.5 GB)。Windows の値は変換したローカルのファイルの合計で、HF 公開後に tree API の値で確定する。英語のページは、話す言語 (英語・日本語) を設定で選べることを動作要件とセットアップの手順に書く
- 会社名: ja「株式会社 Minimal」、en「Minimal, K.K.」
- OG 画像 `public/og-image.jpg`・`public/og-image-en.jpg` は `apps/web/scripts/og-image.mjs ja|en` で作る (2 OS 対応で説明から「Mac」を外して作り直した。Chromium が要るので WSL では Windows 側で実行した)

## 音声コマンド (アプリの既定値を正とする)

| 言い方 (ja) | 言い方 (en) | キー |
|---|---|---|
| 確定 / エンター | enter | Enter |
| 改行 | new line / line break | ⇧ + Enter |
| 送信 | send | ⌘ + Enter (Windows は Ctrl + Enter) |

- 改行のキーは Windows では Shift + Enter と書く (desktop の Windows のキー表記)
- 「取り消し (⌘ + Z)」「すべて選択 (⌘ + A)」は載せない (アプリが未対応)。v2 のデザインは対応済み
- デモの「「送信」→ ⌘ + Enter」は、ページで選んでいる OS のキーにする

## Mac / Windows の 2 OS (2026-10-11、docs/plans/windows-plan.md §10)

- 事前生成の HTML は OS 中立: 判定前の主ボタンは「ダウンロード」(`#requirements` へ移る)、補足は両 OS 対応の表記。動作要件は macOS と Windows の 2 表を並べ、セットアップの手順は両 OS 分を HTML に入れて選んでいない方を `hidden` にする (JS なし・クローラーに両 OS の内容が入る)。meta の description は事前生成の時点の `WINDOWS_AVAILABLE` で選ぶ
- 閲覧 OS (`platform.ts` の `detectPlatform`) で主ボタンと、OS で切り替える部分 (セットアップの手順・ショートカットと音声コマンドのキー表記・常駐場所・デモの入力先のウィンドウの見た目) の初期の OS を決める。セットアップの「macOS / Windows」のタブで利用者が切り替えられ、キー表記・デモも同じ OS になる。Mac・Windows 以外の環境は macOS
- 主ボタン: mac-arm・mac-unknown・windows-x64 = ダウンロード、mac-intel・windows-arm = 非対応 (理由を注記)、linux・other = 「Mac / Windows 版のみ」+ 両 OS のリンクと URL の共有、mobile = URL の共有。ボタンの下に「別の PC で使う場合」のもう一方の OS 版のリンクを出す。Windows (x64) の注記は署名なしの警告の進め方。公開前は Windows の判定結果をすべて「Windows 版は準備中」にする
- `windows-x64` / `windows-arm` は UA-CH の architecture で分ける (Chromium 系のみ)。取れない Safari・Firefox は x64 とみなす (注記に x64 用と書く)
- デモは OS 中立の構成のまま、入力先のウィンドウのタイトルバーだけ OS に合わせる (Mac は左の 3 つの丸と中央の名前、Windows は左の名前と右の最小化・最大化・閉じる)
- よくある質問 (Windows の警告・Smart App Control、GPU のない PC) を動作要件の近くに `details` で置く。フッターに対応 OS を書く

## その他

- OS・CPU の判定 (Apple Silicon / Intel / 判定不可 / Windows x64 / Windows ARM / Linux / スマホ) とボタンの出し分けはデザインに Windows を足したもの (上の「Mac / Windows の 2 OS」)。Chrome・Edge は `navigator.userAgentData.getHighEntropyValues(["architecture"])` で判定する
- スマホ版の「URL をコピー」「共有」(Web Share API) はデザインどおり
- デザインの Tweaks (状態の切り替え) は本番では出さない。開発時の確認用にクエリパラメータで切り替えられるようにする (`?os=mac-arm|mac-unknown|mac-intel|windows-x64|windows-arm|linux|mobile|other`、Windows 版の公開状況 `?windowsAvailable=1|0`、ヒーローのデモのモードの固定 `?heroMode=always|once`)
- ヒーローのデモは 2 つのモードの流れを最後まで進むたびに交互に再生し、タブを押すとそのモードに固定する。動きを減らす設定では入力まで済んだ場面で止める (タブでモードは替えられる)
- 計測は GA4 (測定 ID は `app/lib/site.ts`)。gtag は本番ビルドだけが読み込み、`mukuchi.minimalcorp.com` で開いた時だけ送る (dev・`vite preview`・本番以外のステージは送らない)。同意バナーは出さず、フッターに外部送信の表記と Google の説明へのリンクを置く
  - イベント: `file_download` (ダウンロードボタン・ほかの OS 版のリンク・動作要件の表のリンク。dmg・exe は拡張計測機能の対象外のため自前で送る。`file_extension` は `dmg` / `exe`、`platform` は閲覧中の環境の判定結果 (`mac-arm`・`windows-x64` 等。別の OS の版を落としたかを見分ける))・`github_click`・`share` (`method`: `copy` / `native`)。押した場所は `cta_location` (`header` / `hero` / `final` / `footer` / `requirements`)。管理画面でカスタムディメンションに登録しないとレポートに出ない
  - 拡張計測機能の「ブラウザの履歴イベントに基づくページの変更」はオンのまま (アンカーの移動・戻る・URL の変わらない replaceState では page_view が増えないことを確認済み。React Router の画面遷移を足した時に必要)
  - 実際のダウンロード数は GitHub Releases の `download_count` を正とする (`gh api repos/minimalcorp/mukuchi/releases`)。GA の数字は流入元・押した割合を見るためのもの
