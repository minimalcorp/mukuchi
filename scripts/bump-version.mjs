#!/usr/bin/env node
// リリース用に版 (X.Y.Z) を上げる。.github/workflows/release.yml と手元の確認で使う。Node の標準ライブラリだけを使う
// (リリースの job で依存を入れずに動かすため)。
//
//   node scripts/bump-version.mjs <desktop|web> <patch|minor|major> [--dry-run] [--root <dir>]
//
// 標準出力に JSON を1行出す: {"target","from","to","tag","files":[...]}。--dry-run はファイルを書かない。
//
// desktop の版は4か所にあり、すべて同じでなければ止める (どれが正か決められないため):
//   apps/desktop/src-tauri/tauri.conf.json (.app の CFBundleShortVersionString の元)
//   apps/desktop/src-tauri/Cargo.toml ([package] の version)
//   apps/desktop/src-tauri/Cargo.lock (mukuchi 自身の項目。直さないと cargo の --locked が失敗する)
//   apps/desktop/package.json
// web は apps/web/package.json のみ。
//
// ファイルは該当の1行だけを置き換える (JSON を再シリアライズすると書式が変わり差分が汚れるため)。
// 置き換えた後に読み直して、版以外が変わっていないことを確かめる。
import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function nextVersion(current, bump) {
  const m = SEMVER.exec(current);
  // プレリリース (-beta 等) は公開しても Latest にならず、LP の固定 URL が指さないため扱わない
  if (!m) throw new Error(`版が X.Y.Z の形でない: '${current}'`);
  const [major, minor, patch] = m.slice(1).map(Number);
  switch (bump) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`bump は patch|minor|major のいずれか: '${bump}'`);
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 置き換えがちょうど1か所であることを求める (0 や 2 以上は想定外の形なので止める)
function replaceOnce(text, re, replacer, what) {
  const matches = [
    ...text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")),
  ];
  if (matches.length !== 1)
    throw new Error(`${what}: 置き換え対象が ${matches.length} か所 (1 か所であるべき)`);
  return text.replace(re, replacer);
}

// JSON の最上位の "version"。最上位のキーは2文字のインデントである前提 (リポジトリの書式)
const json = {
  read(text) {
    return JSON.parse(text).version;
  },
  write(text, from, to, file) {
    const re = new RegExp(`^(  "version":\\s*")${escapeRe(from)}(")`, "m");
    const out = replaceOnce(text, re, `$1${to}$2`, file);
    const before = JSON.parse(text);
    const after = JSON.parse(out);
    if (after.version !== to || !isDeepStrictEqual({ ...after, version: from }, before)) {
      throw new Error(`${file}: version 以外が変わった`);
    }
    return out;
  },
};

// Cargo.toml の [package] 節の version (依存の version = "..." には触れない)
function cargoPackageSection(text, file) {
  const start = text.search(/^\[package\]\s*$/m);
  if (start < 0) throw new Error(`${file}: [package] がない`);
  const rest = text.slice(start + 1);
  const next = rest.search(/^\[/m);
  const end = next < 0 ? text.length : start + 1 + next;
  return { start, end, body: text.slice(start, end) };
}
const cargoToml = {
  read(text, file) {
    const m = /^version\s*=\s*"([^"]*)"\s*$/m.exec(cargoPackageSection(text, file).body);
    if (!m) throw new Error(`${file}: [package] に version がない`);
    return m[1];
  },
  write(text, from, to, file) {
    const { start, end, body } = cargoPackageSection(text, file);
    const re = new RegExp(`^(version\\s*=\\s*")${escapeRe(from)}("\\s*)$`, "m");
    const out = text.slice(0, start) + replaceOnce(body, re, `$1${to}$2`, file) + text.slice(end);
    if (cargoToml.read(out, file) !== to) throw new Error(`${file}: 書き換えの確認に失敗`);
    return out;
  },
};

// Cargo.lock の mukuchi 自身の項目 (source 行がない = ワークスペース内のパッケージ)
const LOCK_ENTRY = /^\[\[package\]\]\nname = "mukuchi"\nversion = "([^"]*)"\n(?!source = )/gm;
const cargoLock = {
  read(text, file) {
    const matches = [...text.matchAll(LOCK_ENTRY)];
    if (matches.length !== 1)
      throw new Error(`${file}: mukuchi の項目が ${matches.length} 個 (1 個であるべき)`);
    return matches[0][1];
  },
  write(text, from, to, file) {
    const re = new RegExp(
      `^(\\[\\[package\\]\\]\\nname = "mukuchi"\\nversion = ")${escapeRe(from)}("\\n)(?!source = )`,
      "m",
    );
    const out = replaceOnce(text, re, `$1${to}$2`, file);
    if (cargoLock.read(out, file) !== to) throw new Error(`${file}: 書き換えの確認に失敗`);
    // mukuchi の行以外は変えていないことを確かめる
    if (out.length - text.length !== to.length - from.length)
      throw new Error(`${file}: 想定外の差分`);
    return out;
  },
};

export const TARGETS = {
  desktop: {
    tagPrefix: "desktop-v",
    files: [
      ["apps/desktop/src-tauri/tauri.conf.json", json],
      ["apps/desktop/src-tauri/Cargo.toml", cargoToml],
      ["apps/desktop/src-tauri/Cargo.lock", cargoLock],
      ["apps/desktop/package.json", json],
    ],
  },
  web: {
    tagPrefix: "web-v",
    files: [["apps/web/package.json", json]],
  },
};

export function bump({ root, target, bump: kind, dryRun = false }) {
  const t = TARGETS[target];
  if (!t) throw new Error(`target は ${Object.keys(TARGETS).join("|")} のいずれか: '${target}'`);
  const loaded = t.files.map(([rel, fmt]) => {
    const text = readFileSync(path.join(root, rel), "utf8");
    return { rel, fmt, text, version: fmt.read(text, rel) };
  });
  const versions = new Set(loaded.map((f) => f.version));
  if (versions.size !== 1) {
    throw new Error(`版がそろっていない: ${loaded.map((f) => `${f.rel}=${f.version}`).join(", ")}`);
  }
  const from = loaded[0].version;
  const to = nextVersion(from, kind);
  // すべて検証してから書く (途中で失敗して一部だけ書き換わるのを避ける)
  const outputs = loaded.map((f) => ({ ...f, out: f.fmt.write(f.text, from, to, f.rel) }));
  if (!dryRun) for (const f of outputs) writeFileSync(path.join(root, f.rel), f.out);
  return { target, from, to, tag: `${t.tagPrefix}${to}`, files: loaded.map((f) => f.rel), dryRun };
}

function main(argv) {
  const args = [...argv];
  let dryRun = false;
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pos = [];
  while (args.length) {
    const a = args.shift();
    if (a === "--dry-run") dryRun = true;
    else if (a === "--root") root = path.resolve(args.shift() ?? "");
    else pos.push(a);
  }
  if (pos.length !== 2) {
    console.error(
      "usage: node scripts/bump-version.mjs <desktop|web> <patch|minor|major> [--dry-run] [--root <dir>]",
    );
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(bump({ root, target: pos[0], bump: pos[1], dryRun })));
  } catch (e) {
    console.error(`bump-version: ${e.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
