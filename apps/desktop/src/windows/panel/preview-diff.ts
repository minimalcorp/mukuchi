/*
 * プレビューの差分表示。前回の表示 (途中表示・確定前の最後の途中表示) と新しいテキストを単語単位で比べ、
 * 新しいテキストのどこが挿入・書き換えかを分類する。消えた文字は表示しないので、新しいテキストの側だけを返す。
 * Rust の stableLength (共通接頭辞) は末尾以外の変化を表せないため、表示にはこちらを使う。
 */

/**
 * same: 前回と共通、または末尾への普通の追加 (色付けしない)
 * insert: 前回の語を消さずに途中へ入った語
 * replace: 前回の語が消えた位置に入った語 (途中・末尾とも)
 */
export type DiffKind = "same" | "insert" | "replace";
export type DiffSegment = { text: string; kind: DiffKind };

// DP の表がこれを超える (極端に長い差分) 時は LCS を取らず、差分全体を書き換えとして扱う。
// 途中表示は最長でも 100 秒分 (数百文字) なので通常は届かない
const MAX_DP_CELLS = 400_000;

let segmenter: Intl.Segmenter | null = null;

/** 単語に分ける。空白・句読点も 1 つの語として残し、つなげると元のテキストに戻るようにする */
export function tokenize(text: string): string[] {
  segmenter ??= new Intl.Segmenter("ja", { granularity: "word" });
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/**
 * a と b の LCS で対応する語の組 (a の位置, b の位置) を昇順で返す。
 * 共通の先頭・末尾を除いてから中間だけ DP にする (途中表示は末尾だけ変わることが多く、中間は短い)
 */
function matchTokens(a: string[], b: string[]): [number, number][] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;

  const pairs: [number, number][] = [];
  for (let k = 0; k < head; k++) pairs.push([k, k]);

  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n > 0 && m > 0 && (n + 1) * (m + 1) <= MAX_DP_CELLS) {
    // dp[i][j] = a[head+i..] と b[head+j..] の LCS 長 (後ろから埋めて前から辿る)
    const w = m + 1;
    const dp = new Uint16Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] =
          a[head + i] === b[head + j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[head + i] === b[head + j]) {
        pairs.push([head + i, head + j]);
        i++;
        j++;
      } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
        i++;
      } else {
        j++;
      }
    }
  }

  for (let k = tail; k > 0; k--) pairs.push([a.length - k, b.length - k]);
  return pairs;
}

/**
 * prev から next への変化を next 側の区間に分けて返す (同じ種類の隣り合う区間はまとめる)。
 * prev が空 (最初の途中表示) なら全体が末尾への追加なので色付けしない。
 */
export function diffPreview(prev: string, next: string): DiffSegment[] {
  if (prev === next || prev === "") return next ? [{ text: next, kind: "same" }] : [];
  const a = tokenize(prev);
  const b = tokenize(next);
  const pairs = matchTokens(a, b);

  const out: DiffSegment[] = [];
  const push = (text: string, kind: DiffKind) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last?.kind === kind) last.text += text;
    else out.push({ text, kind });
  };

  // 対応する語の組の間 (gap) ごとに分類する。最後に番兵 (両方の末尾) を置き、末尾の gap も同じ処理で扱う
  let ai = 0;
  let bi = 0;
  for (const [pa, pb] of [...pairs, [a.length, b.length] as [number, number]]) {
    const removed = a.slice(ai, pa).join("");
    const added = b.slice(bi, pb).join("");
    const atEnd = pb === b.length;
    classifyGap(removed, added, atEnd, push);
    if (pb < b.length) push(b[pb], "same");
    ai = pa + 1;
    bi = pb + 1;
  }
  return out;
}

/**
 * 前回の語 removed が消えて added が入った区間を分類する。
 * 語の区切りは文脈で変わる (例: 「から」→「からに」が 1 語になる) ため、語単位では消えて見えても
 * 文字としては残っている場合がある。removed が added の先頭・末尾にそのまま含まれるなら消えていないものとして、
 * 増えた部分だけを挿入 (末尾なら追加) にする。
 */
function classifyGap(removed: string, added: string, atEnd: boolean, push: (text: string, kind: DiffKind) => void) {
  if (!added) return; // 消えただけ。消えた文字は表示しない
  const grown = atEnd ? "same" : "insert";
  if (!removed) {
    push(added, grown);
  } else if (added.startsWith(removed)) {
    push(removed, "same");
    push(added.slice(removed.length), grown);
  } else if (added.endsWith(removed)) {
    push(added.slice(0, added.length - removed.length), "insert");
    push(removed, "same");
  } else {
    // 前回の語が消えた位置に入った語。末尾で書き換えと追加が混ざる場合も区間全体を書き換えにする
    push(added, "replace");
  }
}
