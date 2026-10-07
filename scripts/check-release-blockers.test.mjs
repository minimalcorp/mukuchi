// node --test scripts/ で実行する。プレースホルダの有無は一時ディレクトリの写しで作る
// (実ファイルの今の状態に依存すると、差し替え後にテストが壊れるため)
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BLOCKERS, findBlockers } from "./check-release-blockers.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(repo, "scripts/check-release-blockers.mjs");
const MODELS = BLOCKERS.desktop[0].file;

function tempRoot(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "mukuchi-blockers-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeModels(dir, text) {
  mkdirSync(path.dirname(path.join(dir, MODELS)), { recursive: true });
  writeFileSync(path.join(dir, MODELS), text);
}

function run(root) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, "desktop", "--root", root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GITHUB_ACTIONS: "" },
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    return { code: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

const PLACEHOLDER = 'pub const REVISION_PENDING: &str = "TODO-i18n-pin-commit-after-hf-publish";\n';
const PINNED = 'revision: "698eff963b084561b12a045c95bc4a208898337f",\n';

test("実ファイルを読める (移動・改名で検査が素通りしない)", () => {
  assert.ok(Array.isArray(findBlockers({ root: repo, target: "desktop" })));
});

test("プレースホルダがあれば行番号付きで見つける", (t) => {
  const dir = tempRoot(t);
  writeModels(dir, `// x\n${PINNED}${PLACEHOLDER}`);
  const found = findBlockers({ root: dir, target: "desktop" });
  assert.equal(found.length, 1);
  assert.equal(found[0].file, MODELS);
  assert.equal(found[0].line, 3);
});

test("接頭辞で見る (文言が変わっても捕まえる)", (t) => {
  const dir = tempRoot(t);
  writeModels(dir, 'const X: &str = "TODO-i18n-pin-commit";\n');
  assert.equal(findBlockers({ root: dir, target: "desktop" }).length, 1);
});

test("commit に差し替え済みなら何も見つけない", (t) => {
  const dir = tempRoot(t);
  writeModels(dir, PINNED);
  assert.deepEqual(findBlockers({ root: dir, target: "desktop" }), []);
});

test("対象のファイルが無ければ止める", (t) => {
  const dir = tempRoot(t);
  assert.throws(() => findBlockers({ root: dir, target: "desktop" }), /を読めない/);
});

test("未知の target は止める", () => {
  assert.throws(() => findBlockers({ root: repo, target: "nope" }), /target は/);
});

test("CLI: プレースホルダありで終了コード 1 と理由、なしで 0", (t) => {
  const dir = tempRoot(t);
  // 実ファイルの写しにプレースホルダを足す / 除く
  cpSync(path.join(repo, MODELS), path.join(dir, "orig.rs"));
  const orig = readFileSync(path.join(dir, "orig.rs"), "utf8");

  writeModels(dir, orig + PLACEHOLDER);
  const ng = run(dir);
  assert.equal(ng.code, 1);
  assert.match(ng.stderr, /リリースできない/);
  assert.match(ng.stderr, /セットアップを完了できない/);

  writeModels(dir, orig.replaceAll(/"TODO-i18n-pin-commit[^"]*"/g, '"0000000000000000000000000000000000000000"'));
  const ok = run(dir);
  assert.equal(ok.code, 0, ok.stderr);
});
