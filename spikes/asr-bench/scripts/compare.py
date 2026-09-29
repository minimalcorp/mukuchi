# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""results/*.json を corpus.tsv の正解と突き合わせ、Markdownの比較表を出力する。

使い方: [RESULTS_DIR=...] uv run scripts/compare.py [--baseline <label>] > results/report.md
- CER: 正解テキストに対する文字誤り率(NFKC正規化・句読点/空白除去後)
- vsBase: ベースライン実装の出力に対する文字誤り率(実装間の一致度)
- メモリ: run_all.sh が /usr/bin/time -l で記録した peak memory footprint
"""

import argparse
import csv
import os
import json
import re
import statistics
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS = Path(os.environ.get("RESULTS_DIR", ROOT / "results"))
_PUNCT_RE = re.compile(r"[\s、。，．,.！!？?・…「」『』（）()\[\]〜~]+")


def normalize(text: str) -> str:
    return _PUNCT_RE.sub("", unicodedata.normalize("NFKC", text).lower())


def edit_distance(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def cer(refs: list[str], hyps: list[str]) -> float:
    errors = sum(edit_distance(normalize(r), normalize(h)) for r, h in zip(refs, hyps))
    total = sum(len(normalize(r)) for r in refs)
    return errors / total if total else 0.0


def peak_memory_gb(label: str) -> str:
    path = RESULTS / f"{label}.time.txt"
    if not path.exists():
        return "-"
    m = re.search(r"(\d+)\s+peak memory footprint", path.read_text())
    return f"{int(m.group(1)) / 1e9:.2f}" if m else "-"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", default="python-fp16")
    args = parser.parse_args()

    with open(ROOT / "corpus.tsv", encoding="utf-8") as f:
        corpus = {r["id"]: r["text"] for r in csv.DictReader(f, delimiter="\t")}
    runs = {p.stem: json.loads(p.read_text()) for p in sorted(RESULTS.glob("*.json"))}
    if not runs:
        raise SystemExit("results/*.json がありません")
    base = {r["id"]: r["text"] for r in runs[args.baseline]["results"]} if args.baseline in runs else {}

    print("## サマリ\n")
    print("| label | 実装 | CER | vsBase | 短発話CER | レイテンシ中央値 | p90 | RTF | ロード | メモリ(GB) |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for label, run in runs.items():
        rs = [r for r in run["results"] if r["id"] in corpus]
        ids = [r["id"] for r in rs]
        hyps = [r["text"] for r in rs]
        refs = [corpus[i] for i in ids]
        short = [(corpus[r["id"]], r["text"]) for r in rs if r["id"].startswith("cmd")]
        lat = [r["latency_ms"] for r in rs]
        rtf = sum(r["latency_ms"] / 1000 for r in rs) / sum(r["audio_sec"] for r in rs)
        vs = f"{cer([base[i] for i in ids if i in base], [h for i, h in zip(ids, hyps) if i in base]):.1%}" if base else "-"
        short_cer = f"{cer(*zip(*short)):.1%}" if short else "-"
        p90 = statistics.quantiles(lat, n=10)[-1] if len(lat) >= 2 else lat[0]
        print(f"| {label} | {run['impl']} | {cer(refs, hyps):.1%} | {vs} | {short_cer} | "
              f"{statistics.median(lat):.0f}ms | {p90:.0f}ms | {rtf:.3f} | {run['load_ms'] / 1000:.1f}s | {peak_memory_gb(label)} |")

    print("\n## 発話ごとの出力\n")
    labels = list(runs)
    print("| id | 正解 | " + " | ".join(labels) + " |")
    print("|---|---|" + "---|" * len(labels))
    outputs = {label: {r["id"]: r for r in run["results"]} for label, run in runs.items()}
    for uid, ref in corpus.items():
        cells = []
        for label in labels:
            r = outputs[label].get(uid)
            if r is None:
                cells.append("-")
                continue
            mark = "" if normalize(r["text"]) == normalize(ref) else " ❌"
            cells.append(f"{r['text']}{mark} ({r['latency_ms']:.0f}ms)")
        print(f"| {uid} | {ref} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    main()
