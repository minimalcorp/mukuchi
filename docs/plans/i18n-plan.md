# 多言語対応 (i18n) 計画

対象: desktop (UI・メニューバー・Rust のエラー文言・Info.plist・音声認識) と web (LP)。
表示言語・話す言語とも 日本語 (ja) + 英語 (en) の2つ (話す言語は検証できる言語に限る)。言語の追加は「辞書ファイル1つ + 対応表への登録 (+ 話す言語ならモデルの並び)」で済む構造にする。

## 方針

- **表示言語と話す言語を分ける** (2026-10-06 確定)。表示言語 = UI の言語。話す言語 = ASR に渡す `language` とモデル・音声コマンドの既定を決める。macOS を英語にして日本語を話す人などを両立させるため。`language` を省いた自動判定は ja-8bit の英語で WER 1.8%→28.3% (LibriSpeech) と大きく崩れる (spikes/asr-bench/MODEL_DECISION_I18N.md) ため、話す言語は常に明示して渡す
- 既定は OS (desktop) / ブラウザ (web) の言語から決める。未対応の言語は en にフォールバック
- 翻訳は辞書で管理し、キーの欠落は**型検査で落とす** (ja を正、他言語は `satisfies Messages`)。実行時のフォールバックに頼らない
- 数値・サイズ・日付は `Intl` で整形 (「約 2.2 GB」等の文字列を辞書に直書きしない)。複数形は `Intl.PluralRules`
- ログ (開発者向け) は日本語のまま。翻訳対象は利用者に見える文言だけ

## 言語選択の UX

### desktop

| 場所 | 内容 |
|---|---|
| セットアップ 1枚目 (Welcome) | 「表示言語」「話す言語」の2つの Select を置く (OS の言語で初期選択済み。多くの人は触らず次へ)。表示言語は選んだ瞬間に画面が切り替わる。話す言語でダウンロードするモデルが決まるため、ダウンロード開始 (現状 Welcome の次) より前に置く |
| 設定 > 一般 | 表示言語: 「システムに合わせる (既定) / 日本語 / English」。選択は即時に全ウィンドウ・メニューバーへ反映 (再起動不要) |
| 設定 > 認識 | 話す言語: 「日本語 / English」。モデル一覧は話す言語に合わせて並べ替える (下の「話す言語ごとの推奨モデル」)。話す言語を変えて選択中のモデルが推奨でなくなったら、推奨モデルの取得・切り替えを案内する (強制はしない) |
| 設定 > 音声コマンド | 既定のコマンドは話す言語ごと (ja: 確定・エンター・改行・送信 / en: enter・new line・send)。話す言語を変えた時、利用者が編集していなければ新しい言語の既定に入れ替える |

言語名は各言語の自称で表示 (「English」「日本語」)。どの表示言語でも自分の言語を見つけられるようにするため。

### web (LP)

- URL: `/` = 日本語 (現状維持)、`/en/` = 英語。両方を事前生成し `hreflang` (ja / en / x-default=`/en/`) と `canonical`・`og:locale` を相互に付ける
- **`/` をブラウザの第一言語が日本語以外で開いたら `/en/` へ移す** (2026-10-07 変更。当初は移さず案内バナーを出していた)。描画前に `<head>` のインライン script で `location.replace` し、クエリ・ハッシュは引き継ぐ。移さないのは、言語の切り替えで日本語を選んだ時 (localStorage に記憶) とサイト内から来た時 (同じ origin の referrer。保存できない時の代わり)、クローラー (isbot。Googlebot は英語の `navigator.language` で JS を実行するため、移すと日本語のページを索引できない)。実装は `apps/web/app/i18n/redirect.ts`
- ヘッダー右上とフッターに言語切り替え (「日本語 / English」)
- `/en/` は英語の OG 画像 (現状の og-image.jpg は日本語の文字を含む)

## 設計

### 共通: 言語の定義

- 対応表 (`LOCALES = ["ja", "en"] as const`) を desktop・web それぞれに置く (アプリ間で共有パッケージにはしない。文言は別物のため)
- 辞書: `apps/desktop/src/i18n/{ja,en}.ts`、`apps/web/app/i18n/{ja,en}.ts`。ja の型を `Messages` とし、en は `satisfies Messages`
- ライブラリは入れない (React Context + 型付きの `t` で足りる規模。数百キー)。ICU 相当が要る言語 (複数形が複雑な言語) を足す時に i18next 等を再検討

### desktop: Rust

- `Settings.uiLanguage: "system" | Locale` (既定 `"system"`)、`Settings.speechLanguage: SpeechLanguage` (既定はセットアップで決まる。旧設定は `"ja"` に移行)
- 実際の表示言語は Rust で解決する (macOS の優先言語 → 対応表と照合)。WebView の `navigator.language` は .app の宣言するローカライズに左右されるため使わない
- 解決した言語を command (`get_locale`) と event (`locale-changed`) でフロントエンドへ渡す。変更時はメニューバー・パネルのメニューを作り直す
- メニュー・エラー文言など Rust で作る文言は Rust 側の辞書 (`src/i18n/` に Locale ごとの `match`。キー欠落はコンパイルで落ちる) から取る。表示用エラー (`message`・`error` フィールド) は生成時点の表示言語で作る。インターフェースの「表示用 (日本語)」の記述は「表示用 (表示言語)」に改める
- ASR: `language` を `speechLanguage` から渡す (ja → `Japanese`、en → `English`)

### 話す言語ごとの推奨モデル

精度を最優先にする。その言語に特化したモデルがあればそれを、なければ追加の調整をしていない元のモデル (Qwen 公式) を推奨する。推奨以外も選べるが優先度を下げる。

追加するモデル (`mukuchi-asr-convert` で自前変換し `minimalcorp/` に置き、revision を固定する。mlx-community 版は変換器が mlx-audio で `mlx-qwen3-asr` で読めるか未確認のため使わない):

| id | 元 | 量子化 | 備考 |
|---|---|---|---|
| `ja-8bit` (既存) | neosophie/Qwen3-ASR-1.7B-JA | 8bit | 日本語向けに追加学習。英語も認識できる |
| `base-1.7b-8bit` | Qwen/Qwen3-ASR-1.7B @7278e1e70fe206f11671096ffdd38061171dd6e5 | 8bit | 2.17GB |

選択肢は 1.7B の 8bit だけにする (2026-10-06 決定)。1.7B 5bit・0.6B 8bit も計測した (spikes/asr-bench/MODEL_DECISION_I18N.md) が、省容量・省メモリの効果に比べ精度が下がるため出さない。

話す言語ごとの並び (先頭が推奨。言語ごとに明示し、規則から自動で決めない。2026-10-06 決定。en で ja-8bit と base-1.7b-8bit の精度・容量は誤差の範囲で同等 (spikes/asr-bench/MODEL_DECISION_I18N.md) だが、en は元のモデルを優先する方針):

| 話す言語 | 推奨 | 候補 (この順に優先度を下げる) |
|---|---|---|
| ja | `ja-8bit` | `base-1.7b-8bit` |
| en | `base-1.7b-8bit` | `ja-8bit` |

- カタログ (`provisioning/models.rs`) に `model_order(Locale)` (match) を置く。並びに無いモデルはその言語では出さない (現状は全モデルが ja・en を認識できるので全部出る)
- Rust が話す言語に合わせて並べた一覧を `ModelInfo` に `recommended: boolean` を付けて返す。フロントエンドは受け取った順に表示し、推奨に「推奨」バッジ、`ja-8bit` を en で出す時は「日本語向けに調整」を添える
- セットアップでは話す言語の推奨を取得する。容量の表示も推奨モデルのもの (ja ≒ 2.2 GB、en は変換後の実測)
- 旧候補 (`legacy`) は従来どおり手元にある時だけ出す
- 選択中のモデルが話す言語の変更で推奨でなくなっても自動では切り替えない (取得済みのモデルを勝手に変えない・数GBの取得を勝手に始めない)。認識の画面に「English には ○○ を推奨」と取得/切り替えのボタンを出す

### desktop: macOS バンドル

- Info.plist に `CFBundleLocalizations` (ja, en) と `CFBundleDevelopmentRegion` (en) を追加
- `NSMicrophoneUsageDescription` は `{ja,en}.lproj/InfoPlist.strings` に置き、`bundle.resources` で `Contents/Resources/` に同梱 ([Tauri の公式手順](https://v2.tauri.app/distribute/macos-application-bundle/))
- 権限ダイアログ (TCC) の文言は OS の言語に従い、アプリ内の表示言語とは連動しない (macOS の仕様)

### web

- routes: `index("routes/home.tsx")` と `route("en", "routes/home.en.tsx")` (中身は同じコンポーネントに locale を渡す)。`prerender: ["/", "/en"]`
- `<html lang>`・`meta` を locale ごとに出す。会社名は ja「株式会社 Minimal」(現状の「株式会社Minimal」から空白を入れる)、en「Minimal, K.K.」。`site.ts` の文言系 (タイトル・説明・動作環境・価格・会社名・共有文言) と `content.ts` を辞書へ移す。版・URL・サイズの数値は site.ts に残す
- モデルの容量・名前 (`MODEL_SIZE`・`MODEL_NAME`・動作環境の表・セットアップの所要時間) は locale ごとに、その言語の推奨モデルの値を出す (en の値は変換後に実測して入れる)
- デモ (`demo.tsx`) の発話例・音声コマンドの例も言語別に
- `GOOGLE_PARTNER_SITES_URL` の `hl` を locale に合わせる
- SST の StaticSite は `/en/` → `en/index.html` を返せるか確認する (React Router の prerender の出力パスと合わせる)

## 手順 (担当)

0. **インターフェース更新** (メイン、完了 2026-10-06。docs/architecture.md の「言語」の節): docs/architecture.md に `uiLanguage`・`speechLanguage`・`get_locale`・`locale-changed`・カタログの追加モデルと `model_order`・`ModelInfo.recommended` を追記
1. **モデルの変換・計測** (asr-server-engineer、完了 2026-10-06): 変換器の 5bit 対応・`base-1.7b-8bit`/`base-1.7b-5bit`/`base-0.6b-8bit` の変換 (HF へ公開するのは `base-1.7b-8bit` のみ。公開はユーザーが行う)・asr-bench に英語のコーパスを足し、全モデルの英語/日本語の精度と速度を測定 (5bit と 8bit の差、ja-8bit の英語も)
2. **Rust** (rust-engineer): 設定・言語解決・Rust 辞書・メニュー再構築・カタログ (`base-1.7b-8bit`・`model_order`・`ModelInfo.tunedFor`/`recommended`。HF 公開済み @fc85f8e…)・セットアップで推奨モデルを取得・音声コマンドの言語別既定
3. **desktop フロントエンド** (frontend-engineer): i18n 基盤・全画面の文言の辞書化・言語 Select (Welcome・一般・認識)・mock の言語切り替え・Playwright のスクリーンショットを ja/en 両方で撮る (英語は文字列が長く崩れやすい)
4. **バンドル** (macos-release-engineer): CFBundleLocalizations・InfoPlist.strings
5. **web** (frontend-engineer 相当): ルート・辞書化・言語切り替え・`/` からの英語への移動・hreflang・英語 OG 画像・e2e を両言語で
6. **ユーザーの確認**: 英訳の校正 (特に LP のコピー)
7. レビュー (code-reviewer)

2〜5 は 0 の後なら並行できる。

## 未決 (実装中に確認・ユーザー判断)

- 英語専用の別系統のモデル (Parakeet TDT 等) は見送り: 推論ライブラリが別になり、認識のヒント (プロンプト) を渡せないため。速度が不足する場合に再検討
- 話す言語に ja・en 以外を足すのは、話せる人が検証できる時 (仕組みは `model_order` と音声コマンドの既定を足すだけにしておく)
