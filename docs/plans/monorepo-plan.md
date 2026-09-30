# monorepo 化と LP (web) 追加の計画

## 決定事項 (2026-09-30)

| 項目 | 決定 |
|---|---|
| 構成 | `apps/desktop` (Tauri アプリ一式 + ASRサーバー) と `apps/web` (LP) |
| JS/TS の依存管理 | pnpm workspace (npm から移行)。Rust は Cargo、Python は uv のまま。全体は Nix flake + ルートの Makefile + process-compose で束ねる |
| Cargo | `apps/desktop/src-tauri` を単独パッケージのまま (ルートに Cargo workspace を作らない。`target/`・`Cargo.lock` の位置が変わり多数のパスが壊れるため) |
| ASRサーバー | `apps/desktop/asr-server` (desktop に同梱する部品。`scripts/` からの相対パスが保てる) |
| web の技術 | tech (tech.minimalcorp.com) と同じ: React Router v8 の事前生成 (静的サイト) + Vite + Tailwind v4 |
| 公開 | SST v4 (`sst.aws.Router` + `StaticSite`) で AWS へ。ドメイン `mukuchi.minimalcorp.com`。DNS は別アカウントの Route53 で手動登録、証明書は us-east-1 の ACM を事前発行 (tech と同じ方式) |
| デプロイ | GitHub Actions。承認制の Environment `production-web` + OIDC で AWS のロールを引き受ける |

## ディレクトリ構成

```
/
├─ flake.nix, flake.lock, .envrc, rust-toolchain.toml   (開発環境。ルートに残す)
├─ Makefile                  (全体の入口。desktop・web のコマンドを束ねる)
├─ process-compose.yaml      (make up で起動するもの: asr, desktop, web)
├─ package.json, pnpm-workspace.yaml, pnpm-lock.yaml
├─ sst.config.ts             (web のデプロイ)
├─ .github/workflows/        (ci.yml, release.yml, deploy-web.yml)
├─ CLAUDE.md, LICENSE, .gitignore, .claude/
├─ docs/                     (全体の設計・計画。docs/design/handoff は git 管理外のまま)
├─ assets/brand/             (desktop と web で共有するロゴ・アイコン・dmg 背景)
├─ spikes/                   (検証用コード)
└─ apps/
   ├─ desktop/
   │  ├─ src/, src-tauri/, index.html, e2e/
   │  ├─ package.json, vite.config.ts, tsconfig*.json, eslint.config.js,
   │  │  playwright.config.ts, components.json
   │  ├─ asr-server/
   │  ├─ scripts/            (build-macos・verify・bundle・uninstall・dev-reset など)
   │  └─ THIRD_PARTY_NOTICES (中身が desktop 固有のため)
   └─ web/
      ├─ app/ (routes, root.tsx, globals.css), public/
      └─ package.json, vite.config.ts, react-router.config.ts, tsconfig.json
```

移動は `git mv` で行い、履歴を保つ。

## コマンド (ルートで実行)

| コマンド | 内容 |
|---|---|
| `make up` / `down` / `restart` / `ps` / `logs [s=]` | desktop (asr + tauri dev) と web (vite dev) をまとめて起動・停止 |
| `make up-desktop` / `make up-web` | 片方だけ起動 (process-compose の namespace か個別指定) |
| `make setup` | `pnpm install` + desktop のセットアップ (uv sync・モデル取得・同梱物の用意) |
| `make build` / `build-local` / `dmg-local` / `verify` | desktop のビルド (今と同じ。中で `apps/desktop/scripts/*` を呼ぶ) |
| `make reset` / `up-fresh` | desktop の初回起動の再現 (今と同じ) |
| `make web-build` | web の静的ビルド |
| `make web-deploy` | `sst deploy --stage production` (手元から。通常は CI) |
| `make lint` / `test` | 全アプリの lint・テスト |

既存のコマンド名と動作は変えない (desktop 用のコマンドは今の名前のまま使える)。web の開発サーバーのポートは 1420 (desktop) と重ならない番号にする。

## 修正が必要な箇所 (調査結果の要約)

| 分類 | 対応 |
|---|---|
| Makefile | ルートの入口として書き直す。`scripts/*` → `apps/desktop/scripts/*`、`clean` の対象パス、`.process-compose` の置き場所 (ルート) |
| process-compose.yaml | 各プロセスに `working_dir` を指定 (asr: `apps/desktop`、desktop: `apps/desktop`、web: `apps/web`)。`npm run` → `pnpm run` |
| scripts/ | `apps/desktop/scripts/` に移動。`root=scripts/..` の計算は `apps/desktop` を指すようになり、`src-tauri`・`asr-server`・`.build-cache` は兄弟のまま動く。ルートに残す `assets/brand` への参照だけ `$root/../../assets/brand` に直す (build-macos.sh の dmg 背景、tray/generate.sh)。`node_modules/.bin/tauri` の確認、`npm install`/`npm run` を pnpm に置き換え (setup.sh・build-macos.sh) |
| src-tauri | `tauri.conf.json` の `beforeDevCommand`/`beforeBuildCommand` を pnpm に、`../THIRD_PARTY_NOTICES` はファイルを desktop に移すので変わらない。`include_bytes!`・`build.rs` はフォルダごと動くので変更不要。テストが参照する `../spikes/asr-bench/data/smoke` (pipeline.rs) を `../../../spikes/...` に直す |
| 画面側 | `LICENSE` の読み込み (AboutSection.tsx) の相対パスを直し、Vite の `server.fs.allow` でリポジトリのルートを許可する (または LICENSE を desktop にコピー)。e2e のスクリーンショットの保存先が実行時のディレクトリ基準なので、`apps/desktop` で実行する前提に揃える |
| Nix | `flake.nix` はルートのまま。`rust-toolchain.toml` もルートのまま (flake と rustup の両方がそこから見つける)。devShell に pnpm を追加 |
| CI (ci.yml) | 各ジョブに `working-directory: apps/desktop` などを指定。キャッシュのパスとキー (`src-tauri/target`、`package-lock.json`→`pnpm-lock.yaml`、`asr-server/uv.lock`) を直す。web のジョブ (lint・build) を追加。ジョブ名は ruleset の必須チェックと対応するので、変える場合は GitHub の設定計画 (`.claude/plans/github-setup.md`) も直す |
| release.yml | 成果物のパス (`src-tauri/target/...` → `apps/desktop/src-tauri/target/...`)、スクリプトのパス、`npm ci` → `pnpm install --frozen-lockfile` |
| .gitignore | ルート基準で書いている `src-tauri/target`・`src-tauri/gen/schemas`・`src-tauri/bundle-resources(.tmp)`・`e2e/screenshots/` を `apps/desktop/` 付きに直す。web の生成物 (`.react-router`・`build`・`.sst`) を追加 |
| ドキュメント・エージェント定義 | CLAUDE.md (ディレクトリ表・コマンド表)、docs/architecture.md・docs/release.md・implementation-plan.md、`.claude/agents/*` (担当範囲のパス)、asr-server/README.md、assets/brand/README.md、THIRD_PARTY_NOTICES のパス記載 |
| その他 | `assets/brand/logo` から desktop の `src/assets/brand` への手作業のコピーはそのまま (同期の仕組みは作らない)。ルートにある生成物 (`dist/`・`test-results/`・`.pytest_cache` など) は移行時に削除 |

## web (LP) の hello world

- `apps/web`: React Router v8 (事前生成、`ssr: false`) + Vite + Tailwind v4。tech の `vite.config.ts`・`react-router.config.ts`・`tsconfig.json`・ESLint/Prettier の設定をもとにする
- 1ページ (`/`) に mukuchi のロゴと「mukuchi」「Hello, world」だけを表示。favicon・apple-touch-icon は `assets/brand/web/` のものを `apps/web/public/` に置く
- 多言語化・GA・OG 画像・sitemap は LP 本体の段階で追加する (hello world では入れない)

## SST とデプロイ

```ts
// sst.config.ts (ルート)
app(input) {
  return {
    name: "mukuchi",
    home: "aws",
    removal: input?.stage === "production" ? "retain" : "remove",
    protect: input?.stage === "production" && process.env.SST_ALLOW_REMOVE !== "true",
  };
},
async run() {
  const DOMAIN = "mukuchi.minimalcorp.com";
  const router = new sst.aws.Router("Router", {
    domain: { name: DOMAIN, dns: false, cert: process.env.MUKUCHI_WEB_CERT_ARN },
  });
  new sst.aws.StaticSite("Web", {
    path: "apps/web",
    build: { command: "pnpm run build", output: "build/client" },
    router: { instance: router },
  });
}
```

- (廃止。現在は `.github/workflows/release.yml` の手動実行 target=web。docs/release.md) `.github/workflows/deploy-web.yml`: main の CI 成功後または手動実行 → Environment `production-web` の承認 → OIDC で AWS ロールを引き受け → `sst deploy --stage production`。`apps/web` か `sst.config.ts` に変更がある時だけ動かす
- tech の `undeploy.yml` にならい、手動の撤去用ワークフローも用意する

### あなたの作業が必要なこと (デプロイの前に)

1. ACM (us-east-1) で `mukuchi.minimalcorp.com` の証明書を発行し、DNS 検証のレコードを Route53 (別アカウント) に登録する
2. デプロイ先の AWS アカウントに、GitHub OIDC 用の IAM ロールを作る (tech の `AWS_DEPLOY_ROLE_ARN` と同じ方式。SST のデプロイ権限)
3. GitHub の Environment `production-web` に変数 `AWS_DEPLOY_ROLE_ARN`・`AWS_REGION`・`MUKUCHI_WEB_CERT_ARN` を登録する
4. 初回デプロイ後、表示される CloudFront のドメインへの CNAME/ALIAS を Route53 に登録する

手元での hello world の確認 (`make up` で web が表示される、`make web-build` が通る) までは、これらがなくても進められる。

## 進め方

1. **移行 (desktop)**: pnpm 化とファイル移動、パスの修正を1つのブランチで行う。移動と修正はコミットを分ける (移動だけのコミットで履歴を追いやすくする)
2. **確認 (desktop)**: 下の確認項目をすべて通す
3. **web 追加**: hello world、`make up` への組み込み、CI ジョブ
4. **SST**: `sst.config.ts` とデプロイ用ワークフロー。実際のデプロイはあなたの AWS 側の準備が済んでから

## 確認項目

- `make up` で asr・desktop・web がすべて起動し、`make ps`・`make logs`・`make down` が動く。desktop で音声入力が動く (WAV 入力での自動確認 + あなたの実機確認)
- `make up-fresh`・`make reset` が今と同じに動く
- `make build-local`・`make verify`・`make dmg-local` が通り、`make build` (署名・公証) も通る。ビルドした .app で uv・asr-server・verify.wav が正しく同梱されている
- `cargo fmt/clippy/test`、desktop の `pnpm lint/build/test` (Playwright)、asr-server の `ruff/pytest` が通る
- web の `pnpm lint/build` が通り、`make up` でブラウザに hello world が表示される
- `nix flake check`、actionlint (CI の YAML)、shellcheck (スクリプト)
- `git grep` で旧パス (`src-tauri/`・`scripts/`・`asr-server/` をルート基準で参照している箇所) が残っていないこと
