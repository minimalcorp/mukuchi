# wsl-make.sh から呼ばれる。Windows 側の clone で make を実行し、終了コードをそのまま返す。
param([Parameter(Mandatory = $true)][string]$Dir, [Parameter(ValueFromRemainingArguments = $true)][string[]]$MakeArgs)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# WSL の起動後に入れたツール (Node・Rust 等) は WSL から引き継ぐ PATH に無い。レジストリ (システム + ユーザー) から読み直す。
# %USERPROFILE%\bin は install-dev-tools-windows.ps1 が make・process-compose を置く場所
$reg = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'))
$env:Path = "$env:USERPROFILE\bin;" + ($reg -join ';') + ';' + $env:Path
if (-not (Get-Command make -ErrorAction SilentlyContinue)) {
  Write-Error "make が見つからない。$Dir\apps\desktop\scripts\install-dev-tools-windows.ps1 を実行する"
  exit 1
}
Set-Location $Dir
& make @MakeArgs
exit $LASTEXITCODE
