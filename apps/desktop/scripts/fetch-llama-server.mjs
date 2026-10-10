#!/usr/bin/env node
// Windows 版に同梱する llama-server (llama.cpp の Vulkan 版) を取得して src-tauri/bundle-resources/llama-server/ に展開する。
// バイナリはリポジトリに置かない (公開リポジトリに第三者のバイナリを入れないため)。fetch-uv.sh の Windows 版の位置づけ。
//
// 版は ASR の検証 (spikes/asr-bench/WINDOWS_DECISION.md) と同じ b11408 に固定する。sha256 は GitHub Release の
// asset の digest (API の `digest`) と、実際に取得した zip の計算値が一致することを確かめて転記した値
// (取得のたびに同じサーバーの値と照合するだけでは改ざんを検出できないため)。
// 更新時: https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/<tag> の assets[].digest
//
//   node apps/desktop/scripts/fetch-llama-server.mjs [--out <dir>]
//
// Node の標準ライブラリだけを使う (CI で依存を入れずに動かすため)。zip の展開は Windows 標準の tar (bsdtar) を使う。
// VC++ ランタイム (zip には入っていない) も用意する (fetch-vc-runtime.mjs): llama-server が使うものを同じフォルダに、
// mukuchi.exe が使うものを src-tauri/bundle-resources/vc-runtime/ に (tauri.windows.conf.json がインストール先の直下に置く)。
// 依存の確認は check-windows-dlls.mjs (CI・リリースで実行)。
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_VC, LLAMA_VC, placeVcRuntime } from "./fetch-vc-runtime.mjs";

const TAG = "b11408";
const ASSET = `llama-${TAG}-bin-win-vulkan-x64.zip`;
const SHA256 = "2400e21263c745be6e4d0ca1d91206f0050cf6477b284a508effb8284d7270fd";
const URL = `https://github.com/ggml-org/llama.cpp/releases/download/${TAG}/${ASSET}`;

// 同梱するファイル。llama-server が動く最小構成 (ほかの exe・ベンチ・CLI は入れない)。
// 動作確認済み: これだけで `--list-devices` と Vulkan での推論が動く (WINDOWS_DECISION.md)。
// ggml-cpu-*.dll は CPU の機能ごとの版で、ggml が実行時に CPU に合うものを選ぶため全部入れる
const KEEP = [
  "llama-server.exe",
  "llama-server-impl.dll",
  "llama-common.dll",
  "llama.dll",
  "mtmd.dll",
  "ggml.dll",
  "ggml-base.dll",
  "ggml-vulkan.dll",
  "libomp.dll",
  "LICENSE-LLVM-OpenMP",
];
const KEEP_PATTERNS = [/^ggml-cpu-.*\.dll$/];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const out = path.resolve(outIdx >= 0 ? args[outIdx + 1] : path.join(root, "src-tauri/bundle-resources/llama-server"));
const cache = path.join(root, ".build-cache/llama-server", TAG);
const zip = path.join(cache, ASSET);
const stamp = path.join(out, ".version");

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

// vc-runtime/ は llama-server/ の隣 (--out を変えた時もその隣)
const placeVc = () =>
  placeVcRuntime(out, LLAMA_VC)
    .then(() => placeVcRuntime(path.join(path.dirname(out), "vc-runtime"), APP_VC))
    .catch((e) => {
      console.error(`error: ${e.message}`);
      process.exit(1);
    });

if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === `${TAG} ${SHA256}` && existsSync(path.join(out, "llama-server.exe"))) {
  await placeVc();
  console.log(out);
  process.exit(0);
}

mkdirSync(cache, { recursive: true });
// 取得済みでもハッシュを確認し直す (キャッシュが壊れた・差し替えられた場合に備える)
if (!existsSync(zip) || sha256(zip) !== SHA256) {
  console.error(`==> download llama.cpp ${TAG} (${URL})`);
  const res = await fetch(URL, { redirect: "follow" });
  if (!res.ok) {
    console.error(`error: ${URL} -> HTTP ${res.status}`);
    process.exit(1);
  }
  writeFileSync(`${zip}.part`, Buffer.from(await res.arrayBuffer()));
  renameSync(`${zip}.part`, zip);
}
if (sha256(zip) !== SHA256) {
  rmSync(zip, { force: true });
  console.error(`error: sha256 不一致: ${ASSET} (期待値 ${SHA256})`);
  process.exit(1);
}

const tmp = mkdtempSync(path.join(cache, "x-"));
try {
  const r = spawnSync("tar", ["-xf", zip, "-C", tmp], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error("error: zip の展開に失敗 (Windows 標準の tar が必要)");
    process.exit(1);
  }
  const names = readdirSync(tmp);
  const keep = names.filter((n) => KEEP.includes(n) || KEEP_PATTERNS.some((p) => p.test(n)));
  const missing = KEEP.filter((n) => !names.includes(n));
  if (missing.length > 0) {
    console.error(`error: zip に ${missing.join(", ")} が無い (版を上げた時は KEEP を見直す)`);
    process.exit(1);
  }
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const n of keep) cpSync(path.join(tmp, n), path.join(out, n));
  writeFileSync(stamp, `${TAG} ${SHA256}\n`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
await placeVc();
console.log(out);
