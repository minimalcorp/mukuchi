// node --test scripts/ で実行する。実ファイルの写しを一時ディレクトリに作って書き換える
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bump, nextVersion, TARGETS } from "./bump-version.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function copyRepo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "mukuchi-bump-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const { files } of Object.values(TARGETS)) {
    for (const [rel] of files) cpSync(path.join(repo, rel), path.join(dir, rel));
  }
  return dir;
}

// 変わった行だけを返す (行数は変わらない前提)
function changedLines(a, b) {
  const x = a.split("\n");
  const y = b.split("\n");
  assert.equal(x.length, y.length);
  return x.flatMap((line, i) => (line === y[i] ? [] : [[line, y[i]]]));
}

test("nextVersion", () => {
  assert.equal(nextVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(nextVersion("0.1.9", "minor"), "0.2.0");
  assert.equal(nextVersion("1.2.3", "major"), "2.0.0");
  assert.throws(() => nextVersion("1.2.3-beta.1", "patch"));
  assert.throws(() => nextVersion("01.2.3", "patch"));
  assert.throws(() => nextVersion("1.2.3", "prerelease"));
});

for (const target of Object.keys(TARGETS)) {
  for (const kind of ["patch", "minor", "major"]) {
    test(`${target} ${kind}: 版の行だけが変わる`, (t) => {
      const dir = copyRepo(t);
      const before = Object.fromEntries(
        TARGETS[target].files.map(([rel]) => [rel, readFileSync(path.join(dir, rel), "utf8")]),
      );
      const dry = bump({ root: dir, target, bump: kind, dryRun: true });
      for (const rel of Object.keys(before))
        assert.equal(readFileSync(path.join(dir, rel), "utf8"), before[rel]);

      const r = bump({ root: dir, target, bump: kind });
      assert.deepEqual({ ...r, dryRun: true }, dry);
      assert.equal(r.to, nextVersion(r.from, kind));
      assert.equal(r.tag, `${target}-v${r.to}`);
      for (const rel of Object.keys(before)) {
        const diff = changedLines(before[rel], readFileSync(path.join(dir, rel), "utf8"));
        assert.equal(diff.length, 1, rel);
        assert.equal(diff[0][1], diff[0][0].replace(r.from, r.to), rel);
      }
    });
  }
}

test("desktop: 版がそろっていなければ何も書かずに止める", (t) => {
  const dir = copyRepo(t);
  const pkg = path.join(dir, "apps/desktop/package.json");
  const text = readFileSync(pkg, "utf8");
  const current = JSON.parse(text).version;
  writeFileSync(pkg, text.replace(`"version": "${current}"`, `"version": "9.9.9"`));
  const conf = readFileSync(path.join(dir, "apps/desktop/src-tauri/tauri.conf.json"), "utf8");
  assert.throws(() => bump({ root: dir, target: "desktop", bump: "patch" }), /そろっていない/);
  assert.equal(
    readFileSync(path.join(dir, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
    conf,
  );
});

test("Cargo.toml: 依存の version には触れない", (t) => {
  const dir = copyRepo(t);
  const toml = path.join(dir, "apps/desktop/src-tauri/Cargo.toml");
  const r = bump({ root: dir, target: "desktop", bump: "major" });
  const out = readFileSync(toml, "utf8");
  assert.match(
    out,
    new RegExp(
      `^\\[package\\]\\nname = "mukuchi"\\nversion = "${r.to.replaceAll(".", "\\.")}"$`,
      "m",
    ),
  );
  assert.match(out, /^tauri = \{ version = "2"/m);
});
