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
| `make reset [PROVISION=1] [ALL=1] [PERMISSIONS=1]` | 停止して dev の設定・WebKit/Caches 等を消し初回起動の状態に (models/・実行環境・導入記録・ログは残すのでセットアップのダウンロードは完了済みで表示される。`PROVISION=1` で導入記録を消し導入をやり直す (models/ は残るため取得済みのモデルは再ダウンロードしない。取得から確かめるなら models/ を手で消す)。`ALL=1` で実行環境も消す。`PERMISSIONS=1` で `tccutil reset All <devのID>` と権限の案内)。モデルの選択 (導入記録) も残る |
| `make up-fresh [PROVISION=1] [ALL=1]` | `reset` して `MUKUCHI_DEV_SHOW_SETUP=1` で起動 (セットアップ画面の確認用。この起動のみ) |
| `make ps` / `make logs [s=<name>]` | プロセス状態・ASR の /health・web の応答 / ログ追従 (`s=asr\|app\|web`) |
| `make lint` / `make test` | 全アプリの lint・型検査 (JS/TS・`sst.config.ts`・cargo fmt/clippy・ruff) / テスト (Playwright・cargo test・pytest・`scripts/` のリリース用スクリプト)。CI と同じ検査 |
| `make setup` | pnpm install (workspace)・uv sync・モデル取得 (`up` から自動実行)。モデルは本番の既定と同じ `minimalcorp/Qwen3-ASR-1.7B-JA-MLX-8bit` (約2.2GB) を版固定で取得 (`MUKUCHI_MODEL`・`MUKUCHI_MODEL_REVISION` で変更可、既定は `Makefile`)。取得済みならネットワークに出ない。`MUKUCHI_HF_SEED=<HF_HOME>` で既存HFキャッシュから複製 (複製元に huggingface_hub 2.0 の共通 blob 置き場 `hub/blobs/` があれば複製しない)。アプリのセットアップ済みの dev データなら取得したモデルを導入記録に載せる。**dev で使うモデルは process-compose (この値) で決まり、設定画面のモデルの選択・表示とは食い違いうる** (docs/architecture.md「モデルの管理」の開発) |
| `make build` | 本番用 .dmg (Developer ID署名 + Hardened Runtime + 公証 + staple)。証明書・公証の資格情報が必要 ([docs/release.md](docs/release.md)) |
| `make build-local` | ad-hoc署名の .app (手元確認用)。同梱物 (uv・asr-server) は `apps/desktop/scripts/prepare-bundle-resources.sh` が用意する |
| `make dmg-local` | `build-local` + 署名なしの .dmg (dmg ウィンドウの見た目の確認用。公証しない) |
| `apps/desktop/scripts/uninstall.sh [--dev] [--dry-run]` | 完全アンインストール (既定は確認付き。`--dry-run` で対象の表示のみ) |
| `make verify` / `make clean` | 署名・公証の検証 (ad-hoc なら Gatekeeper・公証の項目は SKIP。`build*` の最後にも実行) / 生成物削除 (devデータは残す) |
| `make web-build` | web の静的ビルド (`apps/web/build/client`) |
| `make web-deploy` | web を本番へ `sst deploy --stage production` (手元から。版・タグは変えない。AWS の認証情報と `MUKUCHI_WEB_CERT_ARN` が必要。通常は下の Release で行う) |
| Actions > Release (`.github/workflows/release.yml`、main で手動実行) | リリース・デプロイの唯一の経路。入力 `target` (`desktop`\|`web`)・`bump` (`patch`\|`minor`\|`major`)。承認 (Environment `release-approval`、先頭で1回) → ビルド・署名・公証 or `sst deploy` → 成功時のみ版上げコミットとタグ (`desktop-v<ver>` / `web-v<ver>`) を Deploy Key で main へ push (main が進んでいたら止まる)。desktop は GitHub Release を公開 ([docs/release.md](docs/release.md)) |
| `node scripts/bump-version.mjs <desktop\|web> <patch\|minor\|major> [--dry-run]` | 版の書き換え (release.yml が使う。desktop は tauri.conf.json・Cargo.toml・Cargo.lock・package.json をそろえる)。テストは `node --test scripts/*.test.mjs` (`make test` に含む) |
| `node scripts/check-release-blockers.mjs desktop` | 配布してはいけない仮の値 (HF 未公開のモデルの revision のプレースホルダ `TODO-i18n-pin-commit*`) が残っていれば理由を出して失敗。release.yml の prepare と `make build` (build-macos.sh の既定・`--build-only`) で実行。`build-local`・`dmg-local` では実行しない |
| `apps/desktop/scripts/dev-windows.ps1 [-DataDir <dir>] [-ForceGpu none\|integrated\|driver_missing\|ok]` | **Windows (ネイティブ。WSL は不可) で開発版を起動** (`pnpm run tauri:dev:windows`)。llama-server (b11408、sha256 固定) と verify.wav を用意してから起動する。前提は Rust (rustup)・VS Build Tools (C++)・Node・pnpm (corepack)。設計は [docs/plans/windows-plan.md](docs/plans/windows-plan.md) |
| Windows の `make` (同じターゲット名) | **Windows ネイティブ (PowerShell 等。WSL は不可) でも上の `make` が同じ名前・意味で動く** (`OS=Windows_NT` なら `Makefile.windows` を読む。nix は使わない)。前提: Git for Windows (レシピのシェルに `sh.exe`)・Rust・VS Build Tools・Node・pnpm と、`apps/desktop/scripts/install-dev-tools-windows.ps1` で `%USERPROFILE%\bin` に入れる GNU make 4.4.1・process-compose 1.122.0 (sha256 固定・管理者権限不要)。違い: ASR は llama-server (Vulkan。GPU が無ければ止まる。`MUKUCHI_DEV_LLAMA_DEVICE=none` で CPU)・モデルは GGUF (`MUKUCHI_MODEL` の既定は `minimalcorp/Qwen3-ASR-1.7B-JA-GGUF`)・dev データは `%LOCALAPPDATA%\com.minimalcorp.mukuchi.dev`・process-compose は TCP `127.0.0.1:18760` (`MUKUCHI_PC_PORT`) + トークン (UDS・`-D` が無いため)・`lint`/`test` は ruff/pytest を省く・`build` / `build-local` は NSIS のインストーラー (下の行)・`dmg-local`/`verify` は macOS 専用で失敗する・`reset` の `PERMISSIONS=1` は無視。`dev-windows.ps1` (上) は process-compose を使わずアプリ自身が llama-server を起動する本番に近い経路 (セットアップ・GPU 判定の確認用) で、`make up-desktop` は Mac と同じ外部 ASR の経路 |
| `make build` / `make build-local` (Windows) | **Windows のインストーラー** `mukuchi_x64-setup.exe` (NSIS・`currentUser`・コード署名なし。`<target>/release/bundle/windows-release/` に .sha256 と)。中身は `apps/desktop/scripts/build-windows.mjs` (同梱物 (llama-server・VC++ ランタイム) → 依存の確認 → `tauri build --bundles nsis` → 中身の確認)。`build-local` は仮の値の検査 (`check-release-blockers`) だけ省く。手順・VC++ ランタイムの扱いは [docs/release.md](docs/release.md) の「Windows」 |
| `node apps/desktop/scripts/check-windows-dlls.mjs [<file\|dir>...]` | Windows の同梱の exe・DLL の依存 (PE の import) が同じフォルダの DLL か Windows 標準に解決できるかを確かめる (OS 不問。既定は `bundle-resources/llama-server`)。VC++ ランタイムは `fetch-vc-runtime.mjs` (`fetch-llama-server.mjs` から呼ばれる) が sha256 固定で置く |
| `make help` | ターゲット一覧 |
| `pnpm lint` / `pnpm build` / `pnpm test` / `pnpm screenshots` (`apps/desktop` で実行) | desktop のフロントエンドの lint / 型チェック+ビルド / Playwright (撮影なし。ja は全件、en は表示とはみ出し・言語で分岐する所だけ、実時間を測るものは最後に 1 worker。分け方は `playwright.config.ts`) / ライト・ダークの主要画面を ja・en で撮影 (`apps/desktop/e2e/screenshots/{ja,en}/`) |
| `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test` (`apps/web` で実行) | web の lint+prettier / 型検査 / 静的ビルド / Playwright (chromium) |

`make` はnix devShell外で実行された場合 `nix develop -c` 経由で実行される。flake はgit管理下のファイルしか見ないため、`flake.nix` 等の新規ファイルは `git add` してから使う。
開発ビルドは `apps/desktop/src-tauri/tauri.dev.conf.json` を重ねて dev のバンドルID (`com.minimalcorp.mukuchi.dev`) で起動する (`apps/desktop` で `pnpm run tauri:dev`)。
pnpm は devShell の版 (ルート `package.json` の `packageManager` と一致させる) を使う。npm・npx は使わない。
