# /// script
# requires-python = ">=3.12"
# dependencies = ["dmgbuild==1.6.7"]
# ///
# dmgbuild (https://github.com/dmgbuild/dmgbuild) の CLI をそのまま呼ぶだけの uv スクリプト。
# 依存は scripts/run-dmgbuild.py.lock (uv lock --script で生成。sha256 付き) に固定し、
# scripts/build-macos.sh が `uv run --locked --script` で実行する。版を上げる時は上の版を変えて
# `uv lock --script scripts/run-dmgbuild.py` を実行し、差分 (dmgbuild・ds_store・mac_alias) を確認する
from dmgbuild.__main__ import main

main()
