# 開発タスク。devShell 外で実行された場合は nix develop -c で自身を再実行する。
SHELL := /bin/bash
.DEFAULT_GOAL := help

NIX ?= nix --extra-experimental-features 'nix-command flakes' --option warn-dirty false

ifeq ($(IN_NIX_SHELL),)

# 複数ゴール指定時も nix develop は1回だけ起動する
_GOALS := $(or $(MAKECMDGOALS),$(.DEFAULT_GOAL))
.PHONY: $(_GOALS)
$(firstword $(_GOALS)):
	@$(NIX) develop -c make --no-print-directory $(_GOALS)
$(wordlist 2,$(words $(_GOALS)),$(_GOALS)):
	@:

else

export MUKUCHI_DEV_DATA := $(HOME)/Library/Application Support/com.minimalcorp.mukuchi.dev
ASR_PORT := 18765
ASR_HEALTH := http://127.0.0.1:$(ASR_PORT)/health
# 開発時に LISTEN するポート: asr-server / vite (strictPort)
DEV_PORTS := $(ASR_PORT) 1420

# UDS モード (TCP 8080 を使わない)。ソケットは固定パスにして別シェルからも操作できるようにする。
# macOS の UDS パス上限 (sun_path 104 バイト、NUL 込み) を超える場合は /tmp の短いパスに逃がす。
# ($TMPDIR は nix develop がセッションごとに変えるため使わない)
PC_DIR := $(CURDIR)/.process-compose
PC_SOCK := $(PC_DIR)/pc.sock
ifneq ($(shell [ $$(printf '%s' '$(PC_SOCK)' | wc -c) -le 103 ] && echo ok),ok)
PC_SOCK := /tmp/mukuchi-pc-$(shell printf '%s' '$(CURDIR)' | shasum | cut -c1-12).sock
endif
PC := process-compose -U -u "$(PC_SOCK)" -L "$(PC_DIR)/process-compose.log"

# 開発用ポートを LISTEN しているプロセス (process-compose がクラッシュした後の残骸など) を表示する。残っていれば真
define dev_port_leftover
pids=$$(for p in $(DEV_PORTS); do lsof -nP -ti tcp:$$p -sTCP:LISTEN; done 2>/dev/null | sort -u); [ -n "$$pids" ] && { \
  echo "開発用ポート ($(DEV_PORTS)) を使用中のプロセスが残っている:"; \
  ps -o pid=,command= -p "$$(echo $$pids | tr ' ' ,)" | sed 's/^/  /'; \
  echo "  不要なら停止する: kill $$(echo $$pids)"; \
}
endef

.PHONY: help up down restart reset up-fresh ps logs setup build build-local verify clean

help: ## ターゲット一覧
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

# 応答しないソケットは process-compose クラッシュ後の残骸なので消す。
# 開発用ポートの残骸プロセスは勝手に kill せず、表示して失敗させる
up: setup ## 開発環境を起動 (セットアップ込み、バックグラウンド)
	@mkdir -p "$(PC_DIR)"
	@if $(PC) process list >/dev/null 2>&1; then \
	  echo "already running (make ps / make down)"; exit 0; \
	fi; \
	rm -f "$(PC_SOCK)"; \
	if $(dev_port_leftover); then echo "error: 起動できない (make down で確認)"; exit 1; fi; \
	$(PC) up -D && echo "started: make ps / make logs [s=asr|app]"

# 本体プロセスの終了と開発用ポートの解放まで待つ (最大30秒)。restart の up が "already running" や
# ポート競合にならないように。v1.122 の down は子プロセス停止後に戻るが、バージョン差や
# 子プロセスの遅い終了に備えて明示的に確認する
down: ## 開発環境を停止
	@if $(PC) process list >/dev/null 2>&1; then \
	  pc_pid=$$(lsof -nU -Fpn 2>/dev/null | awk -v s="$(PC_SOCK)" '/^p/ {p = substr($$0, 2)} /^n/ && substr($$0, 2) == s {print p; exit}'); \
	  $(PC) down >/dev/null 2>&1 || true; \
	  for _ in $$(seq 1 60); do \
	    if [ -n "$$pc_pid" ] && kill -0 "$$pc_pid" 2>/dev/null; then sleep 0.5; continue; fi; \
	    $(PC) process list >/dev/null 2>&1 && { sleep 0.5; continue; }; \
	    for p in $(DEV_PORTS); do lsof -ti tcp:$$p -sTCP:LISTEN; done 2>/dev/null | grep -q . && { sleep 0.5; continue; }; \
	    break; \
	  done; \
	  echo "stopped"; \
	elif [ -S "$(PC_SOCK)" ]; then \
	  echo "not running (応答しないソケットを削除: process-compose が異常終了した可能性)"; \
	else \
	  echo "not running"; \
	fi; \
	rm -f "$(PC_SOCK)"; \
	if $(dev_port_leftover); then exit 1; fi

restart: down up ## 再起動

# 起動中のアプリが設定を書き戻さないよう先に止める。モデル・実行環境・導入記録は残す
# (PROVISION=1 で導入記録、ALL=1 で実行環境と導入記録、PERMISSIONS=1 で TCC も消す)
reset: ## dev の設定・WebKit データを消して初回起動の状態に (PROVISION=1 / ALL=1 / PERMISSIONS=1)
	@$(MAKE) --no-print-directory down
	@ALL="$(ALL)" PROVISION="$(PROVISION)" PERMISSIONS="$(PERMISSIONS)" scripts/dev-reset.sh

# MUKUCHI_DEV_SHOW_SETUP は今回起動する process-compose (→ app) の環境にだけ渡す。次の make up/restart には残らない
up-fresh: ## reset してセットアップ画面ありで起動 (MUKUCHI_DEV_SHOW_SETUP=1)
	@$(MAKE) --no-print-directory reset
	@MUKUCHI_DEV_SHOW_SETUP=1 $(MAKE) --no-print-directory up

ps: ## プロセス状態と ASR /health
	@$(PC) process list -o wide 2>/dev/null || echo "process-compose: not running"
	@printf 'asr /health: '; curl -fs --max-time 3 $(ASR_HEALTH) && echo || echo "not responding"

logs: ## ログ追従 (s=<name> で個別)
ifdef s
	@$(PC) process logs $(s) -f
else
	@tail -n 200 -F "$(PC_DIR)/all.log"
endif

setup: ## npm install / uv sync / モデル取得
	@scripts/setup.sh

# 署名・公証・.dmg 作成・検証は scripts/build-macos.sh / scripts/verify-macos.sh (手順・資格情報は docs/release.md)
build: ## 本番用 .dmg (Developer ID 署名 + 公証 + staple)
	@scripts/build-macos.sh

build-local: ## ad-hoc 署名の .app (手元確認用)
	@scripts/build-macos.sh --local

verify: ## 署名・公証の検証 (ad-hoc なら Gatekeeper・公証の項目は SKIP)
	@scripts/verify-macos.sh

# 起動中に .process-compose (ソケット) を消すと make down で止められなくなるため先に停止する
clean: ## 生成物を削除 (モデル等の dev データは残す)
	-@$(MAKE) --no-print-directory down
	rm -rf dist src-tauri/target src-tauri/bundle-resources node_modules "$(PC_DIR)"

endif
