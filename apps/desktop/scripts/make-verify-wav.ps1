# 初回セットアップの verify で使う検証用音声 (「確認します。」の合成音声、16kHz/mono/s16) を作る。make-verify-wav.sh の Windows 版。
# 使い方: make-verify-wav.ps1 <出力先.wav> [文章]
# 生成物はリポジトリに入れない。合成音声のみで、人の録音は含まない。
# 声は Windows 標準の日本語 SAPI 音声 (Microsoft Haruka Desktop)。無い環境では失敗させる (別の声で黙って作らない)
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Text = "確認します。"
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $s.SelectVoice("Microsoft Haruka Desktop")
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
    16000,
    [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
    [System.Speech.AudioFormat.AudioChannel]::Mono)
  $dir = Split-Path -Parent $Out
  if ($dir) { New-Item -ItemType Directory -Force $dir | Out-Null }
  $s.SetOutputToWaveFile($Out, $fmt)
  $s.Speak($Text)
  $s.SetOutputToNull()
} finally {
  $s.Dispose()
}
Write-Output $Out
