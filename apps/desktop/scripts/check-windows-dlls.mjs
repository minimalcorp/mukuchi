#!/usr/bin/env node
// Windows 版に同梱する実行ファイル・DLL の依存 (PE の import) を解析し、すべてが「同じフォルダに置く DLL」か
// 「Windows 11 に標準で入っている DLL」に解決できることを確かめる。クリーンな Windows 11 (VC++ 再頒布可能パッケージ
// 未導入) で起動できない状態を CI・手元で機械的に見つけるため。インストール後に同じフォルダに並ぶもの (グループ) ごとに実行する:
//
//   node apps/desktop/scripts/check-windows-dlls.mjs [<file|dir>...] [--json]
//     llama-server/                : src-tauri/bundle-resources/llama-server (引数なしの既定)
//     インストール先の直下         : <target>/release/mukuchi.exe src-tauri/bundle-resources/vc-runtime
//
// 引数のファイルと、ディレクトリの中の .exe・.dll を 1 つのグループとして扱う。OS に依存しない (WSL・macOS でも動く)。判定にビルドマシンの
// System32 を見ないのは、VS や VC++ 再頒布可能パッケージが入ったマシン (GitHub の runner・開発機) では
// vcruntime140.dll 等が System32 にあり、同梱漏れを見逃すため。代わりに OS 標準の DLL を下の一覧で固定する。
// 通常の import と遅延読み込み (delay-load) の import の両方を見る。Node の標準ライブラリだけを使う。
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Windows 11 x64 の System32 に標準で入っている DLL (小文字)。同梱の DLL が使うものだけを足していく
// (知らない DLL が現れたら失敗させ、一覧に足すか同梱するかを人が決める)。
// api-ms-win-* / ext-ms-win-* (API Set。ユニバーサル CRT の api-ms-win-crt-* を含む) は OS が解決するため別扱い。
// ユニバーサル CRT (ucrtbase.dll) は Windows 10 以降の OS の一部
// (https://learn.microsoft.com/cpp/windows/universal-crt-deployment)
export const WINDOWS_INBOX = new Set([
  "kernel32.dll",
  "kernelbase.dll",
  "ntdll.dll",
  "user32.dll",
  "gdi32.dll",
  "advapi32.dll",
  "shell32.dll",
  "ole32.dll",
  "oleaut32.dll",
  "ws2_32.dll",
  "bcrypt.dll",
  "crypt32.dll",
  "shlwapi.dll",
  "version.dll",
  "ucrtbase.dll",
  "dbghelp.dll",
  "psapi.dll",
  "winmm.dll",
  "iphlpapi.dll",
  "secur32.dll",
  "userenv.dll",
  "rpcrt4.dll",
  "comctl32.dll",
  "comdlg32.dll",
  "setupapi.dll",
  "cfgmgr32.dll",
  "powrprof.dll",
  "dxgi.dll",
  "d3d12.dll",
  "dxcore.dll",
  // mukuchi.exe (Tauri・WebView2・cpal・ort) が使うもの
  "bcryptprimitives.dll",
  "combase.dll",
  "mmdevapi.dll",
  "dwmapi.dll",
  "imm32.dll",
  "uxtheme.dll",
  "propsys.dll",
  "winhttp.dll",
  "ncrypt.dll",
  // DirectML は Windows 10 1903 以降の OS の一部 (ort の DirectML の実行プロバイダーは使っていないが import はある)
  "directml.dll",
]);

// GPU ドライバー (Vulkan ローダー) が入れる DLL。同梱しない (docs/plans/windows-plan.md §8)。
// 無い PC では ggml-vulkan.dll の読み込みに失敗し、GPU 判定が none / driver_missing になる (アプリが扱う)
export const DRIVER_PROVIDED = new Set(["vulkan-1.dll"]);

// VC++ ランタイム (VC++ 再頒布可能パッケージ)。クリーンな Windows 11 には無いため、使うなら同梱が必須
export const VC_RUNTIME = /^(vcruntime140(_1)?|msvcp140(_\d+|_atomic_wait|_codecvt_ids)?|concrt140|vcomp140|vccorlib140)\.dll$/;

const API_SET = /^(api|ext)-ms-win-.*\.dll$/;

// ---- PE の import の解析 --------------------------------------------------------------------------

function rvaToOffset(sections, rva) {
  for (const s of sections) {
    const size = Math.max(s.virtualSize, s.rawSize);
    if (rva >= s.va && rva < s.va + size) return rva - s.va + s.rawPtr;
  }
  return null;
}

function readCString(buf, off) {
  const end = buf.indexOf(0, off);
  return buf.toString("latin1", off, end < 0 ? buf.length : end);
}

// PE ファイルが import する DLL 名 (通常・遅延読み込み)。PE でなければ null
export function peImports(buf) {
  if (buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return null; // "MZ"
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x00004550) return null; // "PE\0\0"
  const machine = buf.readUInt16LE(pe + 4);
  const nsec = buf.readUInt16LE(pe + 6);
  const optSize = buf.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  // データディレクトリの位置: PE32+ (0x20b) は 112、PE32 (0x10b) は 96
  const dd = opt + (magic === 0x20b ? 112 : 96);
  const dir = (i) => ({ rva: buf.readUInt32LE(dd + i * 8), size: buf.readUInt32LE(dd + i * 8 + 4) });
  const sections = [];
  for (let i = 0, s = opt + optSize; i < nsec; i++, s += 40) {
    sections.push({
      virtualSize: buf.readUInt32LE(s + 8),
      va: buf.readUInt32LE(s + 12),
      rawSize: buf.readUInt32LE(s + 16),
      rawPtr: buf.readUInt32LE(s + 20),
    });
  }
  const names = (index, entrySize, nameField) => {
    const out = [];
    const { rva } = dir(index);
    if (!rva) return out;
    let off = rvaToOffset(sections, rva);
    if (off === null) throw new Error(`import ディレクトリ ${index} の RVA が不正`);
    // ディレクトリは全 0 の項目で終わる
    for (; off + entrySize <= buf.length; off += entrySize) {
      if (buf.subarray(off, off + entrySize).every((b) => b === 0)) break;
      const nameOff = rvaToOffset(sections, buf.readUInt32LE(off + nameField));
      if (nameOff === null) throw new Error("DLL 名の RVA が不正");
      out.push(readCString(buf, nameOff));
    }
    return out;
  };
  return {
    machine,
    imports: names(1, 20, 12), // IMAGE_IMPORT_DESCRIPTOR.Name
    delay: names(13, 32, 4), // IMAGE_DELAYLOAD_DESCRIPTOR.DllNameRVA
  };
}

// ---- 判定 ---------------------------------------------------------------------------------------

// paths (ファイル、またはディレクトリ = その中の .exe・.dll) を 1 つのグループとして解析し、各 import の解決先を返す。
// problems が空なら OK
export function checkGroup(paths) {
  const files = [];
  for (const p of paths) {
    if (statSync(p).isDirectory()) {
      for (const n of readdirSync(p)) if (/\.(exe|dll)$/i.test(n)) files.push(path.join(p, n));
    } else {
      files.push(p);
    }
  }
  const names = files.map((f) => path.basename(f));
  const bundled = new Set(names.map((n) => n.toLowerCase()));
  const problems = [];
  const report = [];
  if (bundled.size !== names.length) problems.push("同じ名前のファイルが複数ある");
  if (!names.some((n) => /\.exe$/i.test(n))) problems.push(`${paths.join(", ")} に .exe が無い`);
  for (const file of files.sort()) {
    const f = path.basename(file);
    const info = peImports(readFileSync(file));
    if (!info) {
      problems.push(`${f}: PE ファイルでない`);
      continue;
    }
    // x64 (IMAGE_FILE_MACHINE_AMD64) 以外が混ざっていないこと
    if (info.machine !== 0x8664) problems.push(`${f}: x64 でない (machine 0x${info.machine.toString(16)})`);
    for (const [kind, list] of [["import", info.imports], ["delay", info.delay]]) {
      for (const name of list) {
        const n = name.toLowerCase();
        let via;
        if (bundled.has(n)) via = "bundled";
        else if (API_SET.test(n)) via = "apiset";
        else if (WINDOWS_INBOX.has(n)) via = "windows";
        else if (DRIVER_PROVIDED.has(n)) via = "driver";
        else {
          via = "missing";
          const hint = VC_RUNTIME.test(n) ? " (VC++ ランタイム。apps/desktop/scripts/fetch-vc-runtime.mjs で同じフォルダに置く)" : "";
          // 遅延読み込みは呼ばれなければ読まれないが、どの経路で呼ばれるかを解析できないため同じく失敗にする
          problems.push(`${f}: ${name} (${kind}) が同梱にも Windows 標準にも無い${hint}`);
        }
        report.push({ file: f, dll: name, kind, via });
      }
    }
  }
  return { files: names, report, problems };
}

function main(argv) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const json = argv.includes("--json");
  const pos = argv.filter((a) => a !== "--json");
  const paths = (pos.length > 0 ? pos : [path.join(root, "src-tauri/bundle-resources/llama-server")]).map((p) => path.resolve(p));
  let result;
  try {
    result = checkGroup(paths);
  } catch (e) {
    console.error(`check-windows-dlls: ${e.message}`);
    process.exit(1);
  }
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    // DLL ごとに解決先をまとめて出す (CI のログで依存の全体が見えるように)
    const byDll = new Map();
    for (const r of result.report) {
      const k = r.dll.toLowerCase();
      if (!byDll.has(k)) byDll.set(k, { via: r.via, users: new Set() });
      byDll.get(k).users.add(r.file + (r.kind === "delay" ? " (delay)" : ""));
    }
    for (const [dll, { via, users }] of [...byDll].sort((a, b) => a[1].via.localeCompare(b[1].via) || a[0].localeCompare(b[0]))) {
      const u = [...users];
      const more = u.length > 3 ? ` ほか ${u.length - 3}` : "";
      console.log(`${via.padEnd(8)} ${dll}  <- ${u.slice(0, 3).join(", ")}${more}`);
    }
    console.log(`${result.files.length} ファイル、依存 ${byDll.size} 種類`);
  }
  if (result.problems.length > 0) {
    for (const p of result.problems) console.error(`error: ${p}`);
    process.exit(1);
  }
  console.log(`check-windows-dlls: OK (${paths.join(", ")})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
