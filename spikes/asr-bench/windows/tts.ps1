Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft Haruka Desktop')
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$rows = Get-Content C:\mukuchi-spike\corpus.tsv -Encoding UTF8 | Select-Object -Skip 1
foreach($r in $rows){
  $id,$text = $r -split "`t",2
  foreach($rate in -2,-1,0,1,2){
    $s.Rate = $rate
    $s.SetOutputToWaveFile("C:\mukuchi-spike\data\tts\$id.r$rate.wav", $fmt)
    $s.Speak($text)
    $s.SetOutputToNull()
  }
}
(Get-ChildItem C:\mukuchi-spike\data\tts).Count
