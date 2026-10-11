#!/usr/bin/env node
// Windows の開発環境のセットアップ (make setup。Mac の setup.sh に相当)。
// 初回はモデル (GGUF 2 ファイル、約2.2GB) を取得するため、make up のヘルスチェック待ちがタイムアウトしないよう事前に済ませる。
//
//   1. pnpm install --frozen-lockfile (workspace。lock・マニフェストが前回より新しい時だけ)
//   2. 同梱物: llama-server (fetch-llama-server.mjs)・verify.wav (make-verify-wav.ps1)。tauri-build は dev でも resources を要求する
//   3. モデル: MUKUCHI_MODEL@MUKUCHI_MODEL_REVISION の *.gguf を MUKUCHI_DEV_DATA/models に取得する。
//      アプリの取得 (src-tauri/src/provisioning/hf.rs) と同じ手順・レイアウト (huggingface_hub 互換、スナップショットは
//      blob のハードリンク、作れなければコピー)。tree API の LFS の sha256 で検証し、途中のファイル (.incomplete) は Range で続きから取る。
//      取得済み (trees/<commit>.json に載ったファイルがスナップショットに同じ大きさで揃う) ならネットワークに出ない
//   4. アプリのセットアップ済み (runtime の記録がある) の dev データなら、取得したモデルを provisioned.json に記録する (setup.sh と同じ)
//
// MUKUCHI_ASR_URL を使う dev のアプリはセットアップ済みとみなされる (src-tauri/src/launch.rs) ため、セットアップ画面を出さずに起動する。
// Node の標準ライブラリだけを使う。
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const HF_ENDPOINT = "https://huggingface.co";
// 既定は Makefile.windows と同じ (provisioning/models.rs の Windows のカタログ ja-gguf)
const DEFAULT_MODEL = "minimalcorp/Qwen3-ASR-1.7B-JA-GGUF";
const DEFAULT_REVISION = "7017bd6ff5156a4e9ad32997d2a9e38eedcb370e";
// 通信の一時的な失敗で続きから取り直す回数 (hf.rs の RETRIES と同じ)
const RETRIES = 3;

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(desktop, "../..");

const die = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};
const run = (cmd, args, opts = {}) => {
  // pnpm は .cmd (corepack 等の shim) のことがあり shell 経由でしか起動できない。shell の時は 1 つの文字列で渡す
  // (引数は固定の値だけで、空白を含むものは渡さない)
  const shell = cmd === "pnpm";
  const r = shell
    ? spawnSync([cmd, ...args].join(" "), { stdio: "inherit", shell: true, ...opts })
    : spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) die(`${cmd} ${args.join(" ")} が失敗 (exit ${r.status ?? r.error})`);
};

const dataDir = process.env.MUKUCHI_DEV_DATA || path.join(process.env.LOCALAPPDATA ?? "", "com.minimalcorp.mukuchi.dev");
if (!path.isAbsolute(dataDir)) die(`MUKUCHI_DEV_DATA が絶対パスでない: ${dataDir}`);
const repo = process.env.MUKUCHI_MODEL || DEFAULT_MODEL;
const revision = process.env.MUKUCHI_MODEL_REVISION || DEFAULT_REVISION;
if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) die(`MUKUCHI_MODEL が不正: ${repo}`);
if (!/^[0-9a-f]{40}$/.test(revision)) die(`MUKUCHI_MODEL_REVISION は commit (40 桁) で固定する: ${revision}`);

// ---- 1. pnpm install ----------------------------------------------------------
console.log("==> pnpm install (workspace)");
// pnpm が最後に入れた時の lock (node_modules/.pnpm/lock.yaml) より lock・マニフェストが新しい時だけ入れ直す (setup.sh と同じ)
function pnpmStale() {
  const stamp = path.join(repoRoot, "node_modules/.pnpm/lock.yaml");
  if (!existsSync(stamp)) return true;
  const t = statSync(stamp).mtimeMs;
  const apps = readdirSync(path.join(repoRoot, "apps")).map((a) => path.join(repoRoot, "apps", a, "package.json"));
  return ["pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json"]
    .map((f) => path.join(repoRoot, f))
    .concat(apps)
    .some((f) => existsSync(f) && statSync(f).mtimeMs > t);
}
if (pnpmStale()) {
  run("pnpm", ["install", "--frozen-lockfile"], { cwd: repoRoot });
} else {
  console.log("up to date");
}

// ---- 2. 同梱物 ------------------------------------------------------------------
console.log("==> bundle resources (llama-server, verify.wav)");
run("node", ["scripts/fetch-llama-server.mjs"], { cwd: desktop, stdio: ["inherit", "ignore", "inherit"] });
const verifyWav = path.join(desktop, "src-tauri/bundle-resources/verify.wav");
if (!existsSync(verifyWav)) {
  run(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts\\make-verify-wav.ps1", "-Out", "src-tauri\\bundle-resources\\verify.wav"],
    { cwd: desktop, stdio: ["inherit", "ignore", "inherit"] },
  );
}
console.log("ok");

// ---- 3. モデル ------------------------------------------------------------------
console.log(`==> model: ${repo}@${revision}`);
const hfHome = path.join(dataDir, "models");
const storage = path.join(hfHome, "hub", `models--${repo.replaceAll("/", "--")}`);
const snapshot = path.join(storage, "snapshots", revision);
const treeFile = path.join(storage, "trees", `${revision}.json`);

/** 取得済み: trees/<commit>.json に載ったファイルがスナップショットに同じ大きさで揃い、GGUF の組がある */
function modelCached() {
  let tree;
  try {
    tree = JSON.parse(readFileSync(treeFile, "utf8"));
  } catch {
    return false;
  }
  const files = Object.entries(tree?.files ?? {});
  if (!ggufPair(files.map(([p]) => p))) return false;
  return files.every(([p, info]) => {
    try {
      return statSync(path.join(snapshot, p)).size === info.size;
    } catch {
      return false;
    }
  });
}

/** (LLM, mmproj) の組。ちょうど1つずつある時だけ (hf.rs の gguf_pair と同じ) */
function ggufPair(paths) {
  const g = paths.filter((p) => p.endsWith(".gguf"));
  const isMmproj = (p) => p.split("/").pop().startsWith("mmproj");
  const mm = g.filter(isMmproj);
  const llm = g.filter((p) => !isMmproj(p));
  return llm.length === 1 && mm.length === 1 ? [llm[0], mm[0]] : null;
}

const isHex = (s, n) => typeof s === "string" && s.length === n && /^[0-9a-fA-F]+$/.test(s);
const isSafeRelative = (p) =>
  p.length > 0 && !p.includes("\\") && !p.includes(":") && p.split("/").every((c) => c !== "" && c !== "." && c !== "..");

/** 固定した revision の取得対象 (*.gguf) の一覧 (hf.rs の list_files と同じ。ページ分割にも従う) */
async function listFiles() {
  const out = [];
  let url = `${HF_ENDPOINT}/api/models/${repo}/tree/${revision}?recursive=true`;
  while (url) {
    const res = await fetch(url, { headers: { "user-agent": "mukuchi-dev-setup" } });
    if (!res.ok) die(`tree API: HTTP ${res.status} (${url})`);
    const next = (res.headers.get("link") ?? "").split(",").find((p) => /rel="next"/.test(p));
    url = next ? next.split(";")[0].trim().replace(/^</, "").replace(/>$/, "") : null;
    for (const e of await res.json()) {
      if (e.type !== "file" || !e.path.endsWith(".gguf")) continue;
      if (!isSafeRelative(e.path)) die(`不正なパス: ${e.path}`);
      const lfs = e.lfs;
      const blob = (lfs ? lfs.oid : e.oid).toLowerCase();
      if (!isHex(blob, lfs ? 64 : 40) || !isHex(e.oid, 40)) die(`不正な blob id: ${blob}`);
      out.push({
        path: e.path,
        size: lfs ? lfs.size : e.size,
        blob,
        sha256: lfs ? blob : null,
        gitOid: e.oid.toLowerCase(),
      });
    }
  }
  if (!ggufPair(out.map((f) => f.path))) die("GGUF の組 (LLM と mmproj) が一覧に無い (リポジトリ・revision の取り違え)");
  return out;
}

const resolveUrl = (p) => `${HF_ENDPOINT}/${repo}/resolve/${revision}/${p.split("/").map(encodeURIComponent).join("/")}`;
const fileSize = (p) => {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
};
const mib = (n) => `${(n / 1024 / 1024).toFixed(0)}MiB`;

async function hashFile(p, f) {
  const h = createHash(f.sha256 ? "sha256" : "sha1");
  // LFS でないファイルは git の blob id (sha1("blob <size>\0" + 内容))
  if (!f.sha256) h.update(`blob ${f.size}\0`);
  await pipeline(createReadStream(p), h);
  return h.digest("hex");
}

/** 1 回の取得。続きから取れたら true、一時的な失敗なら Error を返す (hf.rs の attempt と同じ扱い) */
async function attempt(f, incomplete) {
  let start = fileSize(incomplete);
  if (start > f.size) {
    rmSync(incomplete, { force: true });
    start = 0;
  }
  if (start === f.size) return null;
  const headers = { "user-agent": "mukuchi-dev-setup" };
  if (start > 0) headers.range = `bytes=${start}-`;
  let res;
  try {
    res = await fetch(resolveUrl(f.path), { headers, redirect: "follow" });
  } catch (e) {
    return e;
  }
  let append;
  if (res.status === 206) {
    // 範囲が要求と合わない応答は書かずに取り直す (続きとしてつなぐと壊れるため)
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers.get("content-range") ?? "");
    if (!m || Number(m[1]) !== start || Number(m[2]) !== f.size - 1 || Number(m[3]) !== f.size) {
      await res.body?.cancel();
      return new Error(`Content-Range が要求と合わない: ${res.headers.get("content-range")}`);
    }
    append = true;
  } else if (res.status === 200) {
    append = false; // 範囲指定を無視された: 最初から
  } else if (res.status === 416) {
    rmSync(incomplete, { force: true });
    return new Error("416 Range Not Satisfiable");
  } else if (res.status === 429 || res.status >= 500) {
    return new Error(`HTTP ${res.status}`);
  } else {
    die(`${f.path}: HTTP ${res.status}`);
  }
  let done = append ? start : 0;
  let last = 0;
  const progress = new TransformProgress((n) => {
    done += n;
    const now = Date.now();
    if (now - last > 5000) {
      last = now;
      console.log(`  ${f.path}: ${mib(done)} / ${mib(f.size)}`);
    }
  });
  try {
    await pipeline(Readable.fromWeb(res.body), progress, createWriteStream(incomplete, { flags: append ? "a" : "w" }));
  } catch (e) {
    return e;
  }
  return fileSize(incomplete) === f.size ? null : new Error(`途中で切れた (${fileSize(incomplete)} / ${f.size})`);
}

class TransformProgress extends Transform {
  constructor(onBytes) {
    super();
    this.onBytes = onBytes;
  }
  _transform(chunk, _enc, cb) {
    this.onBytes(chunk.length);
    cb(null, chunk);
  }
}

async function download(f) {
  const blob = path.join(storage, "blobs", f.blob);
  // blob は検証を終えてから最終の名前にするため、名前と大きさが合えば取得済み
  if (fileSize(blob) === f.size) return;
  const incomplete = `${blob}.incomplete`;
  mkdirSync(path.dirname(blob), { recursive: true });
  const resumed = fileSize(incomplete);
  console.log(`  ${f.path} (${mib(f.size)}${resumed ? `、${mib(resumed)} から再開` : ""})`);
  for (let retries = 0; ; ) {
    const err = await attempt(f, incomplete);
    if (!err) break;
    retries += 1;
    console.error(`  warn: 取得が中断 (${f.path}, ${retries}回目): ${err.message ?? err}`);
    if (retries > RETRIES) die(`${f.path} を取得できない`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** (retries - 1)));
  }
  const got = await hashFile(incomplete, f);
  const want = f.sha256 ?? f.gitOid;
  if (got !== want) {
    rmSync(incomplete, { force: true });
    die(`${f.path} のハッシュが一致しない (期待値 ${want}、実際 ${got})。消したので make setup をやり直す`);
  }
  renameSync(incomplete, blob);
}

/** snapshots/<commit>/<path> に blob のハードリンク (作れなければコピー)。hf.rs の Windows の link と同じ */
function link(f) {
  const dest = path.join(snapshot, ...f.path.split("/"));
  mkdirSync(path.dirname(dest), { recursive: true });
  rmSync(dest, { force: true });
  const blob = path.join(storage, "blobs", f.blob);
  try {
    linkSync(blob, dest);
  } catch (e) {
    console.error(`  warn: ハードリンクを作れないためコピーする (${f.path}): ${e.code ?? e}`);
    copyFileSync(blob, dest);
  }
}

/** trees/<commit>.json (huggingface_hub 2.0 の一覧のキャッシュ。hf.rs の write_tree と同じ形) と refs/main */
function writeTreeAndRef(files) {
  const map = {};
  for (const f of files) {
    const info = { size: f.size, blob_id: f.gitOid };
    if (f.sha256) Object.assign(info, { lfs_sha256: f.sha256, lfs_size: f.size });
    map[f.path] = info;
  }
  mkdirSync(path.dirname(treeFile), { recursive: true });
  const tmp = `${treeFile}.tmp`;
  writeFileSync(tmp, JSON.stringify({ format_version: 1, files: map }, null, 2));
  renameSync(tmp, treeFile);
  mkdirSync(path.join(storage, "refs"), { recursive: true });
  writeFileSync(path.join(storage, "refs/main"), revision);
}

/** 同じリポジトリの他の revision のもの (snapshots・trees・参照されない blobs) を消す (hf.rs の prune_other_revisions と同じ) */
function pruneOtherRevisions(files) {
  const keep = {
    snapshots: (n) => n === revision,
    trees: (n) => n === `${revision}.json`,
    blobs: (n) => files.some((f) => f.blob === n),
  };
  for (const [dir, ok] of Object.entries(keep)) {
    const d = path.join(storage, dir);
    if (!existsSync(d)) continue;
    for (const n of readdirSync(d)) {
      if (!ok(n)) rmSync(path.join(d, n), { recursive: true, force: true });
    }
  }
}

if (modelCached()) {
  console.log("cached (skip download)");
} else {
  const files = await listFiles();
  console.log(`取得: ${files.map((f) => f.path).join(", ")} (計 ${mib(files.reduce((a, f) => a + f.size, 0))})`);
  for (const f of files) {
    await download(f);
    link(f);
  }
  writeTreeAndRef(files);
  pruneOtherRevisions(files);
  if (!modelCached()) die(`取得後も ${snapshot} に必要なファイルがない`);
}
console.log(`ok: ${snapshot}`);

// ---- 4. 導入の記録 ---------------------------------------------------------------
// アプリのセットアップを済ませたデータ (runtime の記録がある) だけを対象にする (setup.sh と同じ。形式は docs/architecture.md「導入済みの判定」)
const provisioned = path.join(dataDir, "provisioned.json");
if (existsSync(provisioned)) {
  const version = `${repo}@${revision}`;
  let rec;
  try {
    rec = JSON.parse(readFileSync(provisioned, "utf8"));
  } catch (e) {
    console.error(`skip: ${provisioned} を読めない (${e.message})`);
  }
  const legacy = rec?.model;
  const recorded = version in (rec?.models ?? {}) || (legacy && typeof legacy === "object" && legacy.version === version);
  if (rec && typeof rec === "object" && rec.runtime && !recorded) {
    rec.models = rec.models ?? {};
    rec.models[version] = { completedAt: Math.floor(Date.now() / 1000) };
    const tmp = `${provisioned}.setup.tmp`;
    writeFileSync(tmp, JSON.stringify(rec, null, 2));
    renameSync(tmp, provisioned);
    console.log(`recorded: ${version} を取得済みとして ${provisioned} に記録`);
  }
}
