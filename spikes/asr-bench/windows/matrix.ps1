cd C:\mukuchi-spike
$ErrorActionPreference='Continue'
$py='.\venv\Scripts\python'; $b='C:\mukuchi-spike\bin\cuda-13.4-x64'
$models = @(
 @{n='ja';   m='models\gguf\ja-q8_0.gguf';   p='models\gguf\mmproj-ja-bf16.gguf'},
 @{n='base'; m='models\gguf\base-q8_0.gguf'; p='models\gguf\mmproj-base-bf16.gguf'},
 @{n='ggml'; m='models\ggml-org\Qwen3-ASR-1.7B-Q8_0.gguf'; p='models\ggml-org\mmproj-Qwen3-ASR-1.7B-bf16.gguf'}
)
$sets = @(
 @{n='ja';   a='data\tts';    c='corpus.tsv';              mt='cer'; pf='prefill-ja.txt'},
 @{n='entts';a='data\tts-en'; c='corpus.en.tsv';           mt='wer'; pf='prefill-en.txt'},
 @{n='libri';a='data\libri';  c='data\libri\corpus.tsv';   mt='wer'; pf='prefill-en.txt'}
)
$port=8200
foreach($m in $models){ foreach($s in $sets){
  $port++
  & $py bench.py --bin $b --label "m-$($m.n)-$($s.n)-lang" --model "C:\mukuchi-spike\$($m.m)" --mmproj "C:\mukuchi-spike\$($m.p)" --audio "C:\mukuchi-spike\$($s.a)" --corpus "C:\mukuchi-spike\$($s.c)" --metric $s.mt --prefill-file $s.pf --port $port
  if($m.n -ne 'ggml'){ $port++
  & $py bench.py --bin $b --label "m-$($m.n)-$($s.n)-auto" --model "C:\mukuchi-spike\$($m.m)" --mmproj "C:\mukuchi-spike\$($m.p)" --audio "C:\mukuchi-spike\$($s.a)" --corpus "C:\mukuchi-spike\$($s.c)" --metric $s.mt --port $port }
}}
"ALLDONE"
