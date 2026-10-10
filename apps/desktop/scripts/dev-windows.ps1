# Windows で開発版 (tauri dev) を、アプリ自身が llama-server を起動する本番に近い経路で起動する (process-compose は使わない)。
# セットアップ (モデルの取得・GPU 判定・CPU 同意) の確認用。普段の開発は make up-desktop (Mac と同じく外部の ASR に
# MUKUCHI_ASR_URL で接続し、セットアップ画面を出さない。Makefile.windows)。
# 使い方 (PowerShell): apps\desktop\scripts\dev-windows.ps1 [-DataDir <dir>] [-ForceGpu none|integrated|driver_missing|ok]
#   -DataDir  : dev のデータの置き場所 (MUKUCHI_DEV_DATA_DIR)。省略すると %LOCALAPPDATA%\com.minimalcorp.mukuchi.dev
#   -ForceGpu : GPU の判定結果を差し替える (MUKUCHI_DEV_FORCE_GPU。同意フローの確認用)
# 前提: Rust (rustup。rust-toolchain.toml の版が自動で入る)・VS Build Tools (C++)・Node・pnpm (corepack)
param(
  [string]$DataDir = "",
  [ValidateSet("", "none", "integrated", "driver_missing", "ok")][string]$ForceGpu = ""
)
$ErrorActionPreference = "Stop"
$desktop = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $desktop

# 同梱物 (gitignore。llama-server は sha256 固定で取得、verify.wav は SAPI で合成)
node scripts\fetch-llama-server.mjs | Out-Null
$verify = "src-tauri\bundle-resources\verify.wav"
if (-not (Test-Path $verify)) {
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-verify-wav.ps1 -Out $verify | Out-Null
}

if ($DataDir) { $env:MUKUCHI_DEV_DATA_DIR = $DataDir }
if ($ForceGpu) { $env:MUKUCHI_DEV_FORCE_GPU = $ForceGpu }
pnpm install --frozen-lockfile
pnpm run tauri:dev:windows
