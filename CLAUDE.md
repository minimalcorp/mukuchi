# mukuchi (無口)

macOS常駐の音声入力アプリ。ショートカットでON/OFFし、ONの間は発話ごとにVADで切り出して文字起こしし、フォーカス中のアプリへ入力する。
設計・決定事項は [docs/architecture.md](docs/architecture.md) を正とする。

## 作業ルール

- 回答・ドキュメントは端的に。冗長な説明を避ける
- コード内コメントは日本語で「なぜ」を書く。周辺コードの流儀に合わせる
- 領域ごとの専門subagent (`.claude/agents/`) に作業を委譲する。領域をまたぐ変更はインターフェース(docs/architecture.md の「インターフェース」)を先に更新してから実装する
- 不確実な事項は推測で実装せず、公式ドキュメント・ソースで確認する。確認できない場合は明示する
- commitはメインセッション(またはユーザー)が行う。subagentはcommitしない
- 秘密情報(署名証明書、公証用APIキー、PAT)をリポジトリに置かない。公開リポジトリである

## ディレクトリ

| パス | 内容 | 担当subagent |
|---|---|---|
| `src/` | フロントエンド (React + TypeScript + Vite) | frontend-engineer |
| `src-tauri/` | Tauri v2 / Rust (録音・VAD・ショートカット・入力・ASRサーバー管理) | rust-engineer |
| `asr-server/` | ASRサーバー (Python + MLX, uv管理) | asr-server-engineer |
| `flake.nix`, `Makefile`, `process-compose.yaml`, `scripts/` | 開発環境・タスク | devenv-engineer |
| 署名・公証・entitlements・配布・アンインストール | | macos-release-engineer |
| `spikes/` | 検証用コード(本体から参照しない) | - |

## コマンド

| コマンド | 内容 |
|---|---|
| `make up` / `make down` / `make restart` | 開発環境の起動(セットアップ込み) / 停止 / 再起動 |
| `make reset [ALL=1] [PERMISSIONS=1]` | 停止して dev の設定・`provisioned.json`・WebKit/Caches 等を消し初回起動の状態に (models/ とログは残す。`ALL=1` で実行環境も消す。`PERMISSIONS=1` で `tccutil reset All <devのID>` と権限の案内) |
| `make up-fresh` | `reset` して `MUKUCHI_DEV_SHOW_SETUP=1` で起動 (セットアップ画面の確認用。この起動のみ) |
| `make ps` / `make logs [s=<name>]` | プロセス状態 / ログ追従 |
| `make setup` | npm install・uv sync・モデル取得 (`up` から自動実行)。`MUKUCHI_HF_SEED=<HF_HOME>` で既存HFキャッシュから複製 |
| `make build` | 本番用 .dmg (Developer ID署名 + Hardened Runtime + 公証 + staple)。証明書・公証の資格情報が必要 ([docs/release.md](docs/release.md)) |
| `make build-local` | ad-hoc署名の .app (手元確認用)。同梱物 (uv・asr-server) は `scripts/prepare-bundle-resources.sh` が用意する |
| `scripts/uninstall.sh [--dev] [--dry-run]` | 完全アンインストール (既定は確認付き。`--dry-run` で対象の表示のみ) |
| `make verify` / `make clean` | 署名・公証の検証 (ad-hoc なら Gatekeeper・公証の項目は SKIP。`build*` の最後にも実行) / 生成物削除 (devデータは残す) |
| `make help` | ターゲット一覧 |

`make` はnix devShell外で実行された場合 `nix develop -c` 経由で実行される。flake はgit管理下のファイルしか見ないため、`flake.nix` 等の新規ファイルは `git add` してから使う。
開発ビルドは `src-tauri/tauri.dev.conf.json` を重ねて dev のバンドルID (`com.minimalcorp.mukuchi.dev`) で起動する (`npm run tauri:dev`)。
