#!/usr/bin/env node
// リリースしてはいけない仮の値 (プレースホルダ) がソースに残っていないかを確かめる。.github/workflows/release.yml
// (desktop の prepare) と apps/desktop/scripts/build-macos.sh (make build・CI の --build-only) で使う。
// make build-local・make test では使わない (仮の値のまま手元で試せるように)。Node の標準ライブラリだけを使う
// (リリースの job で依存を入れずに動かすため)。
//
//   node scripts/check-release-blockers.mjs <desktop> [--root <dir>]
//
// 見つかれば理由を標準エラーに出して終了コード 1。対象のファイルが無い場合も 1 (移動・改名で検査が素通りしないため)。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BLOCKERS = {
  desktop: [
    {
      file: "apps/desktop/src-tauri/src/provisioning/models.rs",
      // REVISION_PENDING ("TODO-i18n-pin-commit-after-hf-publish") など。接頭辞で見る (後で文言を変えても捕まえるため)
      marker: "TODO-i18n-pin-commit",
      reason:
        "HF に未公開のモデルの revision がプレースホルダのまま。このまま配布すると、そのモデルを使う利用者 " +
        "(話す言語 en の新規セットアップを含む) はモデルの取得が 404 で失敗しセットアップを完了できない。" +
        "HF に公開して commit (40桁) に差し替え、size_bytes も tree API の値で確かめてからリリースする",
    },
  ],
};

// 見つかったものを [{file, line, text, reason}] で返す
export function findBlockers({ root, target }) {
  const rules = BLOCKERS[target];
  if (!rules) throw new Error(`target は ${Object.keys(BLOCKERS).join("|")} のいずれか: '${target}'`);
  const found = [];
  for (const { file, marker, reason } of rules) {
    let text;
    try {
      text = readFileSync(path.join(root, file), "utf8");
    } catch (e) {
      throw new Error(`${file} を読めない (${e.code ?? e.message})。移動したなら BLOCKERS を直す`);
    }
    text.split("\n").forEach((line, i) => {
      if (line.includes(marker)) found.push({ file, line: i + 1, text: line.trim(), reason });
    });
  }
  return found;
}

function main(argv) {
  const args = [...argv];
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pos = [];
  while (args.length) {
    const a = args.shift();
    if (a === "--root") root = path.resolve(args.shift() ?? "");
    else pos.push(a);
  }
  if (pos.length !== 1) {
    console.error("usage: node scripts/check-release-blockers.mjs <desktop> [--root <dir>]");
    process.exit(2);
  }
  let found;
  try {
    found = findBlockers({ root, target: pos[0] });
  } catch (e) {
    console.error(`check-release-blockers: ${e.message}`);
    process.exit(1);
  }
  if (found.length === 0) {
    console.log(`check-release-blockers: ${pos[0]} にプレースホルダは残っていない`);
    return;
  }
  // GitHub Actions では ::error 注釈にする (Summary とファイルの該当行に出る)
  const gha = process.env.GITHUB_ACTIONS === "true";
  for (const f of found) {
    const msg = `${f.file}:${f.line}: リリースできない: ${f.reason}\n  ${f.text}`;
    if (gha) console.log(`::error file=${f.file},line=${f.line}::${msg.replace(/\n/g, "%0A")}`);
    else console.error(`error: ${msg}`);
  }
  process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
