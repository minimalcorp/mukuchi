#!/usr/bin/env bash
# 開発環境のセットアップ。make setup から devShell 内で実行される。
# 初回はモデル(約4GB)を取得するため、make up のヘルスチェック待ちがタイムアウトしないよう事前に済ませる。
# 作業ディレクトリは apps/desktop。JS の依存はリポジトリ直下の pnpm workspace でまとめて入れる
set -euo pipefail

cd "$(dirname "$0")/.."
repo="$(cd ../.. && pwd)"

: "${MUKUCHI_DEV_DATA:=$HOME/Library/Application Support/com.minimalcorp.mukuchi.dev}"
: "${MUKUCHI_MODEL:=neosophie/Qwen3-ASR-1.7B-JA}"
export HF_HOME="$MUKUCHI_DEV_DATA/models"
export UV_CACHE_DIR="$MUKUCHI_DEV_DATA/cache"
mkdir -p "$HF_HOME" "$UV_CACHE_DIR"

echo "==> pnpm install (workspace)"
# pnpm が最後に入れた時の lock (node_modules/.pnpm/lock.yaml) より lock・マニフェストが新しい時だけ入れ直す
pnpm_stale() {
  local stamp="$repo/node_modules/.pnpm/lock.yaml" f
  [ -f "$stamp" ] || return 0
  for f in "$repo"/pnpm-lock.yaml "$repo"/pnpm-workspace.yaml "$repo"/package.json "$repo"/apps/*/package.json; do
    [ "$f" -nt "$stamp" ] && return 0
  done
  return 1
}
if pnpm_stale; then
  pnpm install --dir "$repo"
else
  echo "up to date"
fi

echo "==> uv sync (asr-server)"
if [ -f asr-server/pyproject.toml ]; then
  uv sync --project asr-server
else
  echo "skip: asr-server/pyproject.toml がない"
fi

# 同じモデルのHFキャッシュが手元にあれば複製して再ダウンロードを避ける (任意)。
# 例: MUKUCHI_HF_SEED=$HOME/.tsunagi/whisper/cache make setup
model_dir="models--${MUKUCHI_MODEL//\//--}"
if [ -n "${MUKUCHI_HF_SEED:-}" ] && [ -d "$MUKUCHI_HF_SEED/hub/$model_dir" ] && [ ! -e "$HF_HOME/hub/$model_dir" ]; then
  echo "==> seed model from $MUKUCHI_HF_SEED"
  mkdir -p "$HF_HOME/hub"
  # APFS の clone (macOS cp の -c) で実容量を消費しない。devShell の cp は GNU 版なので絶対パスで呼ぶ。snapshots/ の相対 symlink はそのまま保たれる
  /bin/cp -Rc "$MUKUCHI_HF_SEED/hub/$model_dir" "$HF_HOME/hub/"
fi

# tauri-build は dev でも bundle.resources を要求するため、tauri dev の前に用意する
echo "==> bundle resources (uv, asr-server)"
scripts/prepare-bundle-resources.sh

echo "==> model: $MUKUCHI_MODEL"
# 取得済みなら HF API に問い合わせない (オフライン・HF 障害時でも make up を止めない)。
# snapshots/ のファイルはダウンロード完了後にだけ作られる symlink なので、存在すれば取得済みとみなす
model_cached() {
  local snap f
  for snap in "$HF_HOME/hub/$model_dir"/snapshots/*/; do
    [ -d "$snap" ] || continue
    for f in model.safetensors config.json tokenizer_config.json; do
      [ -e "$snap$f" ] || continue 2
    done
    return 0
  done
  return 1
}
if model_cached; then
  echo "cached (skip download)"
else
  uvx --from huggingface_hub hf download "$MUKUCHI_MODEL" >/dev/null
fi
echo "ok: $HF_HOME/hub/$model_dir"
