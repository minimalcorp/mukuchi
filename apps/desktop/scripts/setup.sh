#!/usr/bin/env bash
# 開発環境のセットアップ。make setup から devShell 内で実行される。
# 初回はモデル(8bit 版、約2.2GB)を取得するため、make up のヘルスチェック待ちがタイムアウトしないよう事前に済ませる。
# 作業ディレクトリは apps/desktop。JS の依存はリポジトリ直下の pnpm workspace でまとめて入れる
set -euo pipefail

cd "$(dirname "$0")/.."
repo="$(cd ../.. && pwd)"

: "${MUKUCHI_DEV_DATA:=$HOME/Library/Application Support/com.minimalcorp.mukuchi.dev}"
# モデルと版 (commit) の既定は Makefile と同じ (make 経由では Makefile の値が渡る)
: "${MUKUCHI_MODEL:=minimalcorp/Qwen3-ASR-1.7B-JA-MLX-8bit}"
: "${MUKUCHI_MODEL_REVISION:=698eff963b084561b12a045c95bc4a208898337f}"
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

# 同じモデルのHFキャッシュが手元にあれば複製して再ダウンロードを避ける (任意)。<HF_HOME>/hub/models--<org>--<name> を丸ごと複製する。
# 固定した版のスナップショットが無ければ、足りないファイルだけ下の hf download で取る。
# 例: MUKUCHI_HF_SEED="<別の MUKUCHI_DEV_DATA>/models" make setup
model_dir="models--${MUKUCHI_MODEL//\//--}"
if [ -n "${MUKUCHI_HF_SEED:-}" ] && [ -d "$MUKUCHI_HF_SEED/hub/$model_dir" ] && [ ! -e "$HF_HOME/hub/$model_dir" ]; then
  if [ -e "$MUKUCHI_HF_SEED/hub/blobs/.huggingface-shared-blobs" ]; then
    # huggingface_hub 2.0 の共通の置き場 (hub/blobs/) がある: models--*/blobs/ はそこへの相対 symlink でありうるため、
    # models--*/ だけを複製すると実体の無い symlink になる。複製せず下の hf download で取る
    echo "warn: $MUKUCHI_HF_SEED/hub に共通の blob 置き場 (blobs/.huggingface-shared-blobs) があるため複製しない" >&2
  else
    echo "==> seed model from $MUKUCHI_HF_SEED"
    mkdir -p "$HF_HOME/hub"
    # APFS の clone (macOS cp の -c) で実容量を消費しない。devShell の cp は GNU 版なので絶対パスで呼ぶ。snapshots/ の相対 symlink はそのまま保たれる
    /bin/cp -Rc "$MUKUCHI_HF_SEED/hub/$model_dir" "$HF_HOME/hub/"
  fi
fi

# tauri-build は dev でも bundle.resources を要求するため、tauri dev の前に用意する
echo "==> bundle resources (uv, asr-server)"
scripts/prepare-bundle-resources.sh

echo "==> model: $MUKUCHI_MODEL@$MUKUCHI_MODEL_REVISION"
snapshot="$HF_HOME/hub/$model_dir/snapshots/$MUKUCHI_MODEL_REVISION"
# 取得済みなら HF API に問い合わせない (オフライン・HF 障害時でも make up を止めない)。
# snapshots/ のファイルはダウンロード完了後にだけ作られる symlink なので、固定した版のものが揃っていれば取得済みとみなす。
# 重みのファイル名はモデルで違う (8bit の自前変換は weights.safetensors、bf16 は model.safetensors) ため *.safetensors で見る
model_cached() {
  local f
  for f in config.json tokenizer_config.json; do
    [ -e "$snapshot/$f" ] || return 1
  done
  # compgen は devShell の bash (readline なし) に無いため glob で見る
  for f in "$snapshot"/*.safetensors; do
    [ -e "$f" ] && return 0
  done
  return 1
}
if model_cached; then
  echo "cached (skip download)"
else
  # 取得対象は asr-server (mlx-qwen3-asr) が読むものだけ (本番の取得と同じ *.json *.safetensors *.txt *.model)。
  # hf は asr-server の uv.lock で固定した huggingface_hub のもの (uvx の最新版だとキャッシュのレイアウトが変わりうる)。
  # huggingface_hub 2.0 は既定で Xet のファイルを hub/blobs/ (リポジトリ共通) に置き、models--*/blobs/ はそこへの symlink になる。
  # それだと models--*/ だけでは完結せず、MUKUCHI_HF_SEED の複製やアプリのモデル削除 (models--*/ を消す) で実体が
  # 取り残される・欠けるため、共通の置き場を使わず本番 (src-tauri/src/provisioning/hf.rs) と同じ自己完結のレイアウトにする
  HF_HUB_DISABLE_SHARED_BLOBS=1 uv run --project asr-server hf download "$MUKUCHI_MODEL" --revision "$MUKUCHI_MODEL_REVISION" \
    --include '*.json' --include '*.safetensors' --include '*.txt' --include '*.model' >/dev/null
  model_cached || { echo "error: 取得後も $snapshot に必要なファイルがない" >&2; exit 1; }
fi
echo "ok: $snapshot"

# アプリ (dev) の導入の記録に、ここで取得したモデルを取得済みとして載せる (設定画面で「一時停止中」に見えないように)。
# アプリのセットアップを済ませたデータ (runtime の記録がある) だけを対象にする。記録が無い・消した後
# (make reset PROVISION=1 等) はアプリのセットアップが取得・記録する。形式は docs/architecture.md「導入済みの判定」
provisioned="$MUKUCHI_DEV_DATA/provisioned.json"
if [ -f "$provisioned" ]; then
  python3 - "$provisioned" "$MUKUCHI_MODEL@$MUKUCHI_MODEL_REVISION" <<'PY'
import json, os, sys, time

path, version = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        rec = json.load(f)
except (OSError, ValueError) as e:
    print(f"skip: {path} を読めない ({e})", file=sys.stderr)
    sys.exit(0)
if not isinstance(rec, dict) or not rec.get("runtime"):
    sys.exit(0)
# 旧形式 (model: {version}) はアプリが読み込み時に models へ移す
legacy = rec.get("model")
if version in (rec.get("models") or {}) or (isinstance(legacy, dict) and legacy.get("version") == version):
    sys.exit(0)
rec["models"] = rec.get("models") or {}
rec["models"][version] = {"completedAt": int(time.time())}
tmp = path + ".setup.tmp"
with open(tmp, "w") as f:
    json.dump(rec, f, indent=2, ensure_ascii=False)
os.replace(tmp, path)
print(f"recorded: {version} を取得済みとして {path} に記録")
PY
fi
