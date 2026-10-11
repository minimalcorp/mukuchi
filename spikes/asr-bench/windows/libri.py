import glob, os, soundfile as sf, numpy as np
base = r'C:\mukuchi-spike\data\LibriSpeech\test-clean'
rows = []
for f in glob.glob(base + r'\*\*\*.trans.txt'):
    rows += [l.rstrip('\n') for l in open(f, encoding='utf-8')]
rows.sort(); step = len(rows)//100
sel = [r for i, r in enumerate(rows) if i % step == 0][:100]
os.makedirs(r'C:\mukuchi-spike\data\libri', exist_ok=True)
out = ['id\ttext']
for r in sel:
    utt, text = r.split(' ', 1); spk, chap, _ = utt.split('-')
    x, sr = sf.read(rf'{base}\{spk}\{chap}\{utt}.flac', dtype='int16'); assert sr == 16000
    sf.write(rf'C:\mukuchi-spike\data\libri\{utt}.wav', x, sr, subtype='PCM_16'); out.append(f'{utt}\t{text}')
open(r'C:\mukuchi-spike\data\libri\corpus.tsv', 'w', encoding='utf-8').write('\n'.join(out) + '\n')
print(len(sel), len(rows))
