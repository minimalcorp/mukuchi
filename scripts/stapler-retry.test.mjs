// node --test scripts/ で実行する。apps/desktop/scripts/lib/stapler-retry.sh の retry_network を、
// 呼び出しごとに出力・終了コードを変える偽の stapler で確かめる (本物の stapler は Apple に問い合わせるため使わない)。
// CI の署名 job は devShell 外 (macOS の /bin/bash 3.2) で動くため、MUKUCHI_TEST_BASH=/bin/bash でも通すこと
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(repo, "apps/desktop/scripts/lib/stapler-retry.sh");
const BASH = process.env.MUKUCHI_TEST_BASH || "bash";

// 実際の失敗 (GitHub Actions run 41686831528) の出力
const NETWORK =
  'Processing: /tmp/mukuchi.dmg\nCloudKit query for mukuchi.dmg (2/abc) failed due to "Network Error".\n' +
  'error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."\n' +
  "CloudKit's response is inconsistent with expections: (null)\nThe staple and validate action failed! Error 68.";
const NO_TICKET = "mukuchi.app does not have a ticket stapled to it.";

// replies: 呼び出しごとの [終了コード, 出力]。足りなければ最後のものを繰り返す
function fakeStapler(t, replies) {
  const dir = mkdtempSync(path.join(tmpdir(), "mukuchi-stapler-retry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  replies.forEach(([code, out], i) => {
    writeFileSync(path.join(dir, `code.${i + 1}`), String(code));
    writeFileSync(path.join(dir, `out.${i + 1}`), out);
  });
  const fake = path.join(dir, "stapler");
  writeFileSync(
    fake,
    `#!/bin/sh
d=${JSON.stringify(dir)}
n=$(( $(cat "$d/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$d/count"
m=$n
[ -f "$d/code.$m" ] || m=${replies.length}
cat "$d/out.$m"
exit "$(cat "$d/code.$m")"
`,
  );
  chmodSync(fake, 0o755);
  return { dir, fake, count: () => Number(readFileSync(path.join(dir, "count"), "utf8")) };
}

// build-macos.sh (set -euo pipefail) と同じ条件で呼ぶ。notice を渡すと fd 3 をそのファイルに開く
function run(fake, { notice, opts = "set -euo pipefail", delays = "0 0" } = {}) {
  const script = `${opts}
. "$1"
${notice ? 'exec 3>"$3"' : ""}
retry_network "$2" staple /tmp/mukuchi.dmg
echo "after rc=$?"`;
  const r = spawnSync(BASH, ["-c", script, "bash", LIB, fake, notice ?? ""], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, MUKUCHI_STAPLER_RETRY_DELAYS: delays },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("成功すれば1回で 0", (t) => {
  const s = fakeStapler(t, [[0, "The staple and validate action worked!"]]);
  const r = run(s.fake);
  assert.equal(r.code, 0);
  assert.equal(s.count(), 1);
  assert.match(r.stdout, /action worked!/);
  assert.match(r.stdout, /after rc=0/);
  assert.equal(r.stderr, "");
});

test("通信断 (NSURLErrorDomain) が2回続いても3回目で通れば 0", (t) => {
  const s = fakeStapler(t, [
    [68, NETWORK],
    [68, NETWORK],
    [0, "The staple and validate action worked!"],
  ]);
  const r = run(s.fake);
  assert.equal(r.code, 0);
  assert.equal(s.count(), 3);
  assert.match(r.stdout, /after rc=0/);
  // 告知は fd 3 が無ければ stderr (2回目・3回目の前)
  assert.match(r.stderr, /2\/3 回目/);
  assert.match(r.stderr, /3\/3 回目/);
});

test("通信断が続けば3回で止まり、元の終了コード (68) で set -e により止まる", (t) => {
  const s = fakeStapler(t, [[68, NETWORK]]);
  const r = run(s.fake);
  assert.equal(r.code, 68);
  assert.equal(s.count(), 3);
  assert.doesNotMatch(r.stdout, /after rc=/);
  // 失敗の出力は毎回表示する (FAIL 時に原因を追えるように)
  assert.equal(r.stdout.match(/Error 68\./g).length, 3);
});

test("通信断でない失敗 (票なし) は再試行せず元の終了コード (65)", (t) => {
  const s = fakeStapler(t, [[65, NO_TICKET]]);
  const r = run(s.fake);
  assert.equal(r.code, 65);
  assert.equal(s.count(), 1);
  assert.match(r.stdout, /does not have a ticket/);
  assert.equal(r.stderr, "");
});

test("通信断のあとの通信断でない失敗は、そこで止めてその終了コード (65)", (t) => {
  const s = fakeStapler(t, [
    [68, NETWORK],
    [65, NO_TICKET],
  ]);
  const r = run(s.fake);
  assert.equal(r.code, 65);
  assert.equal(s.count(), 2);
});

test("fd 3 が読み取り専用でも告知は stderr に出て再試行を続ける", (t) => {
  const s = fakeStapler(t, [
    [68, NETWORK],
    [0, "The staple and validate action worked!"],
  ]);
  const r = run(s.fake, { opts: "set -euo pipefail\nexec 3</dev/null" });
  assert.equal(r.code, 0);
  assert.equal(s.count(), 2);
  assert.match(r.stderr, /2\/3 回目/);
  assert.doesNotMatch(r.stderr, /Bad file descriptor/);
});

test("set -e なし (verify-macos.sh の set -uo pipefail) では終了コードを呼び出し側が受け取れる", (t) => {
  const s = fakeStapler(t, [[68, NETWORK]]);
  const r = run(s.fake, { opts: "set -uo pipefail" });
  assert.equal(r.code, 0);
  assert.equal(s.count(), 3);
  assert.match(r.stdout, /after rc=68/);
});

test("fd 3 が開いていれば告知は fd 3 に出る (verify の check が出力を握っても残るように)", (t) => {
  const s = fakeStapler(t, [
    [68, NETWORK],
    [0, "The staple and validate action worked!"],
  ]);
  const notice = path.join(s.dir, "notice");
  const r = run(s.fake, { notice });
  assert.equal(r.code, 0);
  assert.equal(s.count(), 2);
  assert.equal(r.stderr, "");
  assert.match(readFileSync(notice, "utf8"), /NSURLErrorDomain.*2\/3 回目/);
  assert.doesNotMatch(r.stdout, /回目/);
});

test("待ち時間の数で回数が決まり、不正な値は実行前に弾く", (t) => {
  const s = fakeStapler(t, [[68, NETWORK]]);
  assert.equal(run(s.fake, { delays: "0" }).code, 68);
  assert.equal(s.count(), 2);
  const bad = fakeStapler(t, [[0, "ok"]]);
  const r = run(bad.fake, { delays: "0 x" });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /不正/);
});

test("既定の待ち時間は 10秒・30秒", () => {
  const lib = readFileSync(LIB, "utf8");
  assert.match(lib, /MUKUCHI_STAPLER_RETRY_DELAYS:-10 30\}/);
});
