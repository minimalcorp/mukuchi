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
monorepo。JS/TS の依存はルートの pnpm workspace (`pnpm-workspace.yaml`・`pnpm-lock.yaml`)、Rust は Cargo (`apps/desktop/src-tauri` 単独)、Python は uv。計画は [docs/plans/monorepo-plan.md](docs/plans/monorepo-plan.md)。

| パス | 内容 | 担当subagent |
|---|---|---|
| `apps/desktop/src/` | フロントエンド (React + TypeScript + Vite) | frontend-engineer |
| `apps/desktop/src-tauri/` | Tauri v2 / Rust (録音・VAD・ショートカット・入力・ASRサーバー管理) | rust-engineer |
| `apps/desktop/asr-server/` | ASRサーバー (Python + MLX, uv管理) | asr-server-engineer |
| `flake.nix`, `Makefile`, `process-compose.yaml`, `package.json`, `pnpm-workspace.yaml`, `apps/desktop/scripts/`, `scripts/` (リリースの版上げ), `.github/workflows/` | 開発環境・タスク・CI・リリース | devenv-engineer |
| 署名・公証・entitlements・配布・アンインストール | | macos-release-engineer |
| `assets/brand/` | ロゴ・アイコン・dmg 背景 (desktop と web で共有) | - |
| `spikes/` | 検証用コード(本体から参照しない) | - |

## コマンド

| コマンド | 内容 |
|---|---|
| `make up` / `make down` / `make restart` | 開発環境の起動(desktop + web、セットアップ込み) / 停止 / 再起動 |
| `make up-desktop` / `make up-web` | desktop (asr + tauri dev) / web (LP の vite dev、http://127.0.0.1:5174/) だけを起動 (process-compose の namespace `desktop` / `web`。片方の起動中に別の `up-*` は不可。`make down` してから) |
| `make reset [PROVISION=1] [ALL=1] [PERMISSIONS=1]` | 停止して dev の設定・WebKit/Caches 等を消し初回起動の状態に (models/・実行環境・導入記録・ログは残すのでセットアップのダウンロードは完了済みで表示される。`PROVISION=1` で導入記録を消しダウンロード・導入をやり直す。`ALL=1` で実行環境も消す。`PERMISSIONS=1` で `tccutil reset All <devのID>` と権限の案内) |
| `make up-fresh [PROVISION=1] [ALL=1]` | `reset` して `MUKUCHI_DEV_SHOW_SETUP=1` で起動 (セットアップ画面の確認用。この起動のみ) |
| `make ps` / `make logs [s=<name>]` | プロセス状態・ASR の /health・web の応答 / ログ追従 (`s=asr\|app\|web`) |
| `make lint` / `make test` | 全アプリの lint・型検査 (JS/TS・`sst.config.ts`・cargo fmt/clippy・ruff) / テスト (Playwright・cargo test・pytest・`scripts/` のリリース用スクリプト)。CI と同じ検査 |
| `make setup` | pnpm install (workspace)・uv sync・モデル取得 (`up` から自動実行)。`MUKUCHI_HF_SEED=<HF_HOME>` で既存HFキャッシュから複製 |
| `make build` | 本番用 .dmg (Developer ID署名 + Hardened Runtime + 公証 + staple)。証明書・公証の資格情報が必要 ([docs/release.md](docs/release.md)) |
| `make build-local` | ad-hoc署名の .app (手元確認用)。同梱物 (uv・asr-server) は `apps/desktop/scripts/prepare-bundle-resources.sh` が用意する |
| `make dmg-local` | `build-local` + 署名なしの .dmg (dmg ウィンドウの見た目の確認用。公証しない) |
| `apps/desktop/scripts/uninstall.sh [--dev] [--dry-run]` | 完全アンインストール (既定は確認付き。`--dry-run` で対象の表示のみ) |
| `make verify` / `make clean` | 署名・公証の検証 (ad-hoc なら Gatekeeper・公証の項目は SKIP。`build*` の最後にも実行) / 生成物削除 (devデータは残す) |
| `make web-build` | web の静的ビルド (`apps/web/build/client`) |
| `make web-deploy` | web を本番へ `sst deploy --stage production` (手元から。版・タグは変えない。AWS の認証情報と `MUKUCHI_WEB_CERT_ARN` が必要。通常は下の Release で行う) |
| Actions > Release (`.github/workflows/release.yml`、main で手動実行) | リリース・デプロイの唯一の経路。入力 `target` (`desktop`\|`web`)・`bump` (`patch`\|`minor`\|`major`)。承認 (Environment `production-desktop` / `production-web`) → ビルド・署名・公証 or `sst deploy` → 成功時のみ版上げコミットとタグ (`desktop-v<ver>` / `web-v<ver>`) を Deploy Key で main へ push (main が進んでいたら止まる)。desktop は GitHub Release を公開 ([docs/release.md](docs/release.md)) |
| `node scripts/bump-version.mjs <desktop\|web> <patch\|minor\|major> [--dry-run]` | 版の書き換え (release.yml が使う。desktop は tauri.conf.json・Cargo.toml・Cargo.lock・package.json をそろえる)。テストは `node --test scripts/*.test.mjs` (`make test` に含む) |
| `make help` | ターゲット一覧 |
| `pnpm lint` / `pnpm build` / `pnpm test` (`apps/desktop` で実行) | desktop のフロントエンドの lint / 型チェック+ビルド / Playwright (スクリーンショットは `apps/desktop/e2e/screenshots/`) |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test` (`apps/web` で実行) | web の lint+prettier / 型検査 / 静的ビルド / Playwright (chromium) |

`make` はnix devShell外で実行された場合 `nix develop -c` 経由で実行される。flake はgit管理下のファイルしか見ないため、`flake.nix` 等の新規ファイルは `git add` してから使う。
開発ビルドは `apps/desktop/src-tauri/tauri.dev.conf.json` を重ねて dev のバンドルID (`com.minimalcorp.mukuchi.dev`) で起動する (`apps/desktop` で `pnpm run tauri:dev`)。
pnpm は devShell の版 (ルート `package.json` の `packageManager` と一致させる) を使う。npm・npx は使わない。
