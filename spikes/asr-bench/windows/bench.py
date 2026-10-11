import argparse, base64, json, re, subprocess, sys, time, unicodedata, urllib.request, statistics, os, glob
import psutil
ap = argparse.ArgumentParser()
ap.add_argument('--bin'); ap.add_argument('--label'); ap.add_argument('--ngl', default='99')
ap.add_argument('--model', default=r'C:\mukuchi-spike\models\gguf\ja-q8_0.gguf')
ap.add_argument('--mmproj', default=r'C:\mukuchi-spike\models\gguf\mmproj-ja-bf16.gguf')
ap.add_argument('--mmproj-offload', default='1')
ap.add_argument('--audio', default=r'C:\mukuchi-spike\data\tts'); ap.add_argument('--limit', type=int, default=0)
ap.add_argument('--context', default=''); ap.add_argument('--prefill', default='')
ap.add_argument('--threads', default=''); ap.add_argument('--port', default='8081'); ap.add_argument('--extra', default='')
ap.add_argument('--corpus', default=r'C:\mukuchi-spike\corpus.tsv'); ap.add_argument('--metric', default='cer'); ap.add_argument('--context-file'); ap.add_argument('--prefill-file')
a = ap.parse_args()
if a.context_file: a.context = open(a.context_file, encoding='utf-8').read().strip()
if a.prefill_file: a.prefill = open(a.prefill_file, encoding='utf-8').read().strip()
corpus = {l.split('\t')[0]: l.rstrip('\n').split('\t', 1)[1] for l in open(a.corpus, encoding='utf-8').read().splitlines()[1:] if '\t' in l}
_DEL = re.compile(r"(?<=\d)[,.](?=\d)|[.'’]")
def words(t): return [w for w in re.split(r'[^\w]+', _DEL.sub('', unicodedata.normalize('NFKC', t).lower())) if w and w != '_']
def norm(s): return re.sub(r'[\s\W_]+', '', unicodedata.normalize('NFKC', s).lower())
def ed(x, y):
    p = list(range(len(y)+1))
    for i, cx in enumerate(x, 1):
        c = [i]
        for j, cy in enumerate(y, 1): c.append(min(p[j]+1, c[j-1]+1, p[j-1]+(cx != cy)))
        p = c
    return p[-1]
cmd = [os.path.join(a.bin, 'llama-server.exe'), '-m', a.model, '--mmproj', a.mmproj, '-ngl', a.ngl, '--port', a.port, '--host', '127.0.0.1', '-c', '4096', '--no-webui']
if a.mmproj_offload == '0': cmd.append('--no-mmproj-offload')
if a.threads: cmd += ['-t', a.threads]
if a.extra: cmd += a.extra.split()
t0 = time.time()
srv = subprocess.Popen(cmd, stdout=open(f'server-{a.label}.log', 'w'), stderr=subprocess.STDOUT, cwd=a.bin)
url = f'http://127.0.0.1:{a.port}'
while True:
    try:
        urllib.request.urlopen(url + '/health', timeout=1); break
    except Exception:
        if srv.poll() is not None: sys.exit('server died, see log')
        time.sleep(0.2)
load = time.time() - t0
def call(path):
    b = base64.b64encode(open(path, 'rb').read()).decode()
    msgs = []
    if a.context: msgs.append({'role': 'system', 'content': a.context})
    msgs.append({'role': 'user', 'content': [{'type': 'input_audio', 'input_audio': {'data': b, 'format': 'wav'}}]})
    body = {'messages': msgs, 'temperature': 0, 'max_tokens': 256}
    if a.prefill: body['messages'].append({'role': 'assistant', 'content': a.prefill}); body['continue_final_message'] = True; body['add_generation_prompt'] = False
    r = urllib.request.Request(url + '/v1/chat/completions', json.dumps(body).encode(), {'Content-Type': 'application/json'})
    t = time.time(); d = json.load(urllib.request.urlopen(r, timeout=120)); return d['choices'][0]['message']['content'], time.time() - t
files = sorted(glob.glob(a.audio + r'\*.wav'))
if a.limit: files = files[:a.limit]
call(files[0])  # warmup
res = []; peak_rss = 0; dur = 0
import wave
for f in files:
    txt, lat = call(f)
    w = wave.open(f); d = w.getnframes()/w.getframerate(); dur += d
    clean = re.sub(r'^language\s+\w+<asr_text>', '', txt).strip()
    ref = corpus[os.path.basename(f).split('.')[0]]
    res.append(dict(file=os.path.basename(f), raw=txt, text=clean, ref=ref, lat=lat, dur=d, ed=(ed(words(clean), words(ref)) if a.metric == 'wer' else ed(norm(clean), norm(ref))), n=(len(words(ref)) if a.metric == 'wer' else len(norm(ref))), nonum=not re.search(r'\d', ref)))
    try: peak_rss = max(peak_rss, psutil.Process(srv.pid).memory_info().rss)
    except Exception: pass
srv.terminate()
lats = sorted(r['lat'] for r in res)
cer = sum(r['ed'] for r in res)/max(1,sum(r['n'] for r in res))
nn=[r for r in res if r['nonum']]
out = dict(label=a.label, metric=a.metric, err_nonum=round(100*sum(r['ed'] for r in nn)/max(1,sum(r['n'] for r in nn)),2), load_s=round(load, 2), cer=round(cer*100, 2), median_ms=round(statistics.median(lats)*1000), p90_ms=round(lats[int(len(lats)*0.9)-1]*1000),
           rtf=round(sum(lats)/dur, 3), rss_mb=round(peak_rss/1048576), n=len(res))
print(json.dumps(out)); json.dump(dict(summary=out, results=res), open(f'result-{a.label}.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
