#!/usr/bin/env node
// Windows 版が依存する VC++ ランタイムの DLL を、使う実行ファイルと同じフォルダに置く (app-local。クリーンな Windows 11 には
// 無く、無いと起動できないため)。依存は apps/desktop/scripts/check-windows-dlls.mjs (PE の import) で確認した:
//   - llama-server/ (llama.cpp の公式バイナリ): vcruntime140・vcruntime140_1・msvcp140
//   - インストール先の直下 (mukuchi.exe。ort (ONNX Runtime の静的ライブラリ) が msvcp140・msvcp140_1 を import する。
//     Tauri は vcruntime を静的リンクするが、msvcp140 自体が vcruntime140・vcruntime140_1 を import する)
// DLL の検索は実行ファイルのフォルダが先なので、フォルダごとに置く。fetch-llama-server.mjs から呼ぶ
// (tauri-build は bundle.resources の存在を要求するため、Windows のビルド・開発の前に必ず通る場所で用意する)。
// Tauri の bundle.windows.bundleVCRuntime は使わない (ビルドマシンの VS の最新版をそのまま入れ、版・中身を固定できず、
// 置き場所もインストール先の直下だけで llama-server/ に置けないため)。
//
// 取得元: Microsoft の Visual C++ 2015-2022 再頒布可能パッケージ (x64) の版付きの URL (内容が変わらない)。
// 中身は VS 2022 の VC\Redist\MSVC\<版>\x64\Microsoft.VC143.CRT の DLL と同じバイト列 (14.44.35112 で照合済み)。
// 再頒布の根拠: VS 2022 の Distributable Code (REDIST list の「Visual C++ Runtime Files」:
// https://learn.microsoft.com/visualstudio/releases/2022/redistribution)。アプリのフォルダに置く方式 (app-local) は
// Microsoft が「サービス (自動更新) の面で推奨しない」が可能な方式 (https://learn.microsoft.com/cpp/windows/redistributing-visual-cpp-files)。
// NSIS で再頒布可能パッケージを入れる方式は管理者権限が要り、インストーラー (currentUser) の前提と合わないため使わない。
// 更新はこのファイルの版・sha256 を上げて llama-server と一緒にリリースする (docs/release.md の「Windows」)。
//
// バイナリはリポジトリに置かない。exe とその中の DLL の両方を sha256 で固定する。展開は Windows 標準の tar (bsdtar。
// cab を読める) を使い、exe の中の cab (Burn のコンテナ) → 中の cab を順に展開して、ハッシュが一致するファイルを選ぶ
// (cab の中の名前は `vcruntime140.dll_amd64` 等で、名前ではなく中身で選ぶ)。Node の標準ライブラリだけを使う。
//
//   node apps/desktop/scripts/fetch-vc-runtime.mjs --out <dir> --files <a.dll,b.dll>
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VC_VERSION = "14.44.35112";
// https://aka.ms/vs/17/release/vc_redist.x64.exe の転送先 (2026-10-10。パスに sha256 を含む版付きの URL)。
// VS Build Tools 2022 の VC\Redist\MSVC\14.44.35112\vc_redist.x64.exe と同じ sha256
const URL =
  "https://download.visualstudio.microsoft.com/download/pr/bd1c8d9d-ba95-4eee-bc6e-df1fcc876373/CC0FF0EB1DC3F5188AE6300FAEF32BF5BEEBA4BDD6E8E445A9184072096B713B/VC_redist.x64.exe";
const SHA256 = "cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b";
// 値は VC\Redist\MSVC\14.44.35112\x64\Microsoft.VC143.CRT の同名のファイルの sha256
export const VC_FILES = {
  "vcruntime140.dll": "d5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066",
  "vcruntime140_1.dll": "1f2d41c4aa5db0bc33ebf7b66d72943a817d7ce6cbe880502a9403823633093f",
  "msvcp140.dll": "0f885b509a685d2bbfa652fed26b5fb31d88fbdab0a978c641d1c7b8aa460aa9",
  "msvcp140_1.dll": "bfad5aef4c63a669e3c140655cdfdf395b6c979b400a447bd5dcb65ed8826c3d",
};
// 置き場所ごとに必要なもの (check-windows-dlls.mjs で依存を確かめて決めた。余計なものは置かない)
export const LLAMA_VC = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll"];
export const APP_VC = ["vcruntime140.dll", "vcruntime140_1.dll", "msvcp140.dll", "msvcp140_1.dll"];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const CAB_MAGIC = Buffer.from("MSCF\0\0\0\0");

// buf の中の cab (先頭 "MSCF" + 予約 4 バイト、オフセット 8 に全体の長さ) を切り出す
export function findCabs(buf) {
  const out = [];
  for (let i = buf.indexOf(CAB_MAGIC); i >= 0; i = buf.indexOf(CAB_MAGIC, i + 4)) {
    if (i + 36 > buf.length) break;
    const size = buf.readUInt32LE(i + 8);
    if (size >= 36 && i + size <= buf.length) out.push(buf.subarray(i, i + size));
  }
  return out;
}

function tarExtract(file, dir) {
  const r = spawnSync("tar", ["-xf", file, "-C", dir], { stdio: ["ignore", "ignore", "pipe"] });
  if (r.error || r.status !== 0) {
    throw new Error(`cab を展開できない (Windows 標準の tar が必要): ${r.error?.message ?? r.stderr}`);
  }
}

// cab を再帰的に展開し、sha256 → パスの表を返す (深さ 2 まで: exe の中の cab → その中の cab)
function extractAll(exe, work) {
  const found = new Map();
  let n = 0;
  const walk = (buf, depth) => {
    for (const cab of findCabs(buf)) {
      const dir = path.join(work, String(n++));
      mkdirSync(dir);
      const f = `${dir}.cab`;
      writeFileSync(f, cab);
      tarExtract(f, dir);
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (!statSync(p).isFile()) continue;
        found.set(sha256(p), p);
        if (depth < 2) {
          const b = readFileSync(p);
          if (b.subarray(0, 8).equals(CAB_MAGIC)) walk(b, depth + 1);
        }
      }
    }
  };
  walk(readFileSync(exe), 1);
  return found;
}

// out に names が揃っているか (中身まで)
export function vcRuntimePresent(out, names) {
  return names.every((n) => existsSync(path.join(out, n)) && sha256(path.join(out, n)) === VC_FILES[n]);
}

// out に names (VC_FILES のキー) を置く。揃っていれば何もしない (ネットワークに出ない)
export async function placeVcRuntime(out, names, { log = (m) => console.error(m) } = {}) {
  for (const n of names) if (!VC_FILES[n]) throw new Error(`未知の DLL: ${n}`);
  if (vcRuntimePresent(out, names)) return;
  const cache = path.join(root, ".build-cache/vc-runtime", VC_VERSION);
  const exe = path.join(cache, "VC_redist.x64.exe");
  mkdirSync(cache, { recursive: true });
  if (!existsSync(exe) || sha256(exe) !== SHA256) {
    log(`==> download VC++ redistributable ${VC_VERSION} (${URL})`);
    const res = await fetch(URL, { redirect: "follow" });
    if (!res.ok) throw new Error(`${URL} -> HTTP ${res.status}`);
    writeFileSync(`${exe}.part`, Buffer.from(await res.arrayBuffer()));
    renameSync(`${exe}.part`, exe);
  }
  if (sha256(exe) !== SHA256) {
    rmSync(exe, { force: true });
    throw new Error(`sha256 不一致: VC_redist.x64.exe (期待値 ${SHA256})`);
  }
  const work = mkdtempSync(path.join(cache, "x-"));
  try {
    const found = extractAll(exe, work);
    mkdirSync(out, { recursive: true });
    for (const name of names) {
      const hash = VC_FILES[name];
      const src = found.get(hash);
      if (!src) throw new Error(`VC_redist.x64.exe に ${name} (sha256 ${hash}) が無い (版を上げた時は VC_FILES を見直す)`);
      copyFileSync(src, path.join(out, name));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  if (!vcRuntimePresent(out, names)) throw new Error("VC++ ランタイムを置いた後の確認に失敗");
  log(`==> VC++ runtime ${VC_VERSION}: ${names.join(", ")} -> ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (k) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : undefined);
  if (!get("--out") || !get("--files")) {
    console.error("usage: node apps/desktop/scripts/fetch-vc-runtime.mjs --out <dir> --files <a.dll,b.dll>");
    process.exit(2);
  }
  const out = path.resolve(get("--out"));
  placeVcRuntime(out, get("--files").split(",")).then(
    () => console.log(out),
    (e) => {
      console.error(`fetch-vc-runtime: ${e.message}`);
      process.exit(1);
    },
  );
}
