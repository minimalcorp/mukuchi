# Windows ネイティブの開発に使う GNU make と process-compose を、管理者権限なしでユーザー領域に入れる。
# Mac の devShell (flake.nix の gnumake・process-compose) に相当する。nix は Windows では使わない。
# 使い方 (PowerShell): powershell -NoProfile -ExecutionPolicy Bypass -File apps\desktop\scripts\install-dev-tools-windows.ps1 [-BinDir <dir>]
#   -BinDir : 置き場所 (既定 %USERPROFILE%\bin)。ユーザーの PATH に無ければ足す (ユーザーの環境変数のみ。新しいシェルから有効)
# 版と sha256 は固定する (取得のたびに同じサーバーの値と照合するだけでは改ざんを検出できないため、公式の値を転記した):
#   process-compose: GitHub Release の process-compose_checksums.txt と asset の digest (API の `digest`) が一致することを確認
#                    版は Mac の devShell (nixpkgs) と同じ v1.122.0
#   make: winget の ezwinports.make 4.4.1 のマニフェストの InstallerSha256 (SourceForge の配布物。make.exe 単体で動く)
# 前提 (別途): Git for Windows (make のシェルに sh.exe を使う)・Node・pnpm・Rust (rustup)・VS Build Tools (C++)
param(
  [string]$BinDir = (Join-Path $env:USERPROFILE "bin")
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$tools = @(
  @{
    Name    = "process-compose"
    Version = "1.122.0"
    Url     = "https://github.com/F1bonacc1/process-compose/releases/download/v1.122.0/process-compose_windows_amd64.zip"
    Sha256  = "13fd7023199c7375c26477f11f213fde826e932d831f7dd51a5c229fbee3bf79"
    # zip 内のパス -> BinDir に置く名前
    Files   = @{ "process-compose.exe" = "process-compose.exe" }
  },
  @{
    Name    = "make"
    Version = "4.4.1"
    Url     = "https://downloads.sourceforge.net/project/ezwinports/make-4.4.1-without-guile-w32-bin.zip"
    Sha256  = "fb66a02b530f7466f6222ce53c0b602c5288e601547a034e4156a512dd895ee7"
    Files   = @{ "bin\make.exe" = "make.exe" }
  }
)

New-Item -ItemType Directory -Force $BinDir | Out-Null
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("mukuchi-devtools-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $tmp | Out-Null
try {
  foreach ($t in $tools) {
    # 入れた版を印に残し、同じ版・同じハッシュなら取り直さない
    $stamp = Join-Path $BinDir (".{0}.version" -f $t.Name)
    $want = "{0} {1}" -f $t.Version, $t.Sha256
    $have = if (Test-Path $stamp) { (Get-Content $stamp -Raw).Trim() } else { "" }
    $present = @($t.Files.Values | Where-Object { -not (Test-Path (Join-Path $BinDir $_)) }).Count -eq 0
    if ($have -eq $want -and $present) {
      Write-Output ("ok: {0} {1} (導入済み)" -f $t.Name, $t.Version)
      continue
    }
    Write-Output ("==> {0} {1} ({2})" -f $t.Name, $t.Version, $t.Url)
    $zip = Join-Path $tmp ("{0}.zip" -f $t.Name)
    # Windows 標準の curl.exe を使う。SourceForge は UA に Mozilla を含む (Invoke-WebRequest の既定) と
    # ダウンロードページの HTML を返すため (実測。ハッシュの検証で止まる)
    & "$env:SystemRoot\System32\curl.exe" -fsSL --retry 3 -o $zip $t.Url
    if ($LASTEXITCODE -ne 0) { throw ("取得に失敗: {0} (curl exit {1})" -f $t.Url, $LASTEXITCODE) }
    $sha = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
    if ($sha -ne $t.Sha256) {
      throw ("sha256 不一致: {0} (期待値 {1}、実際 {2})" -f $t.Name, $t.Sha256, $sha)
    }
    $x = Join-Path $tmp $t.Name
    Expand-Archive -Path $zip -DestinationPath $x -Force
    foreach ($src in $t.Files.Keys) {
      $from = Join-Path $x $src
      if (-not (Test-Path $from)) { throw ("zip に {0} が無い ({1})" -f $src, $t.Name) }
      Copy-Item -Force $from (Join-Path $BinDir $t.Files[$src])
    }
    Set-Content -Path $stamp -Value $want -Encoding ascii
    Write-Output ("ok: {0} {1} -> {2}" -f $t.Name, $t.Version, $BinDir)
  }
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# ユーザーの PATH (HKCU) に無ければ足す。システムの PATH は変えない
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$entries = @($userPath -split ";" | Where-Object { $_ } | ForEach-Object { $_.TrimEnd("\") })
if ($entries -notcontains $BinDir.TrimEnd("\")) {
  $new = if ($userPath) { $userPath.TrimEnd(";") + ";" + $BinDir } else { $BinDir }
  [Environment]::SetEnvironmentVariable("Path", $new, "User")
  Write-Output ("ユーザーの PATH に {0} を追加した (新しいシェルから有効)" -f $BinDir)
}

# make のシェルは Git for Windows の sh.exe (Makefile.windows)。無ければ案内だけ出す (導入はしない)
$git = @("$env:ProgramFiles\Git\usr\bin\sh.exe", "$env:LOCALAPPDATA\Programs\Git\usr\bin\sh.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $git) {
  Write-Output "warn: Git for Windows の sh.exe が見つからない。make には Git for Windows が必要 (https://gitforwindows.org/)"
}
