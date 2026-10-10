#!/usr/bin/env node
// Windows の開発用 ASR サーバー (process-compose.windows.yaml の asr)。Mac の `uv run mukuchi-asr` に相当する。
// 同梱する llama-server (Vulkan 版。fetch-llama-server.mjs) を、本番 (src-tauri/src/llama.rs の launch_spec) と同じ引数で起動する。
// アプリは MUKUCHI_ASR_URL でここに接続する (外部のサーバーにはキーを付けないため、LLAMA_API_KEY は渡さない)。
//
// 環境変数 (Makefile.windows が export する):
//   MUKUCHI_DEV_DATA        dev のデータディレクトリ (%LOCALAPPDATA%\com.minimalcorp.mukuchi.dev)
//   MUKUCHI_MODEL / MUKUCHI_MODEL_REVISION  使うモデル (make setup が取得したもの)
//   MUKUCHI_DEV_LLAMA_DEVICE (任意) `--device` に渡す名前 (Vulkan0 等)。`none` で CPU (-ngl 0)。
//     省略時は `--list-devices` の VRAM が最大のもの。無ければ CPU にせずエラーで止まる (CPU は遅く、本番も同意が要るため)
//
// パスに \ や空白を含んでも壊れないよう、YAML のコマンドではなくここで引数を組み立てる。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 18765;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exe = path.join(root, "src-tauri/bundle-resources/llama-server/llama-server.exe");

const die = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};

const { MUKUCHI_DEV_DATA: data, MUKUCHI_MODEL: repo, MUKUCHI_MODEL_REVISION: revision } = process.env;
if (!data || !repo || !revision) die("MUKUCHI_DEV_DATA・MUKUCHI_MODEL・MUKUCHI_MODEL_REVISION が必要 (make up-desktop から起動する)");
if (!existsSync(exe)) die(`${exe} がない (make setup で取得する)`);

// スナップショットの (LLM, mmproj) の組 (src-tauri/src/provisioning/hf.rs の gguf_pair と同じ規則: ちょうど1つずつ)
const snapshot = path.join(data, "models/hub", `models--${repo.replaceAll("/", "--")}`, "snapshots", revision);
const ggufs = existsSync(snapshot) ? readdirSync(snapshot).filter((n) => n.endsWith(".gguf")) : [];
const mmproj = ggufs.filter((n) => n.startsWith("mmproj"));
const llm = ggufs.filter((n) => !n.startsWith("mmproj"));
if (llm.length !== 1 || mmproj.length !== 1) die(`${snapshot} に GGUF の組 (LLM と mmproj) がない (make setup で取得する)`);

// `Vulkan0: NVIDIA GeForce RTX 3080 Ti (12084 MiB, 11316 MiB free)` (llama.rs の parse_list_devices と同じ形)
function listDevices() {
  const r = spawnSync(exe, ["--list-devices"], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) die(`llama-server --list-devices が失敗 (exit ${r.status}): ${r.stderr ?? r.error}`);
  return `${r.stdout}\n${r.stderr}`
    .split(/\r?\n/)
    .map((l) => l.trim().match(/^([A-Za-z]+\d+):\s*(.+?)(?:\s+\((\d+) MiB[^)]*\))?$/))
    .filter(Boolean)
    .map(([, id, name, mib]) => ({ id, name, mib: Number(mib ?? 0) }));
}

let device = process.env.MUKUCHI_DEV_LLAMA_DEVICE ?? "";
if (!device) {
  const devices = listDevices();
  if (devices.length === 0) {
    die("llama-server が推論に使える GPU (Vulkan) が見つからない。CPU で動かすなら MUKUCHI_DEV_LLAMA_DEVICE=none (遅い)");
  }
  // 本番 (gpu.rs) は独立 GPU のうち VRAM が大きいものを選ぶ。dev は VRAM だけで決める (同じなら列挙の順)
  const best = devices.reduce((a, b) => (b.mib > a.mib ? b : a));
  device = best.id;
  console.log(`device: ${best.id} (${best.name}${best.mib ? `, ${best.mib} MiB` : ""})`);
}
const offload = device === "none" ? ["-ngl", "0", "--no-mmproj-offload", "--device", "none"] : ["--device", device, "-ngl", "99"];

const args = [
  "-m", path.join(snapshot, llm[0]),
  "--mmproj", path.join(snapshot, mmproj[0]),
  ...offload,
  "--port", String(PORT),
  "--host", "127.0.0.1",
  "-c", "4096",
  "--no-webui",
  "--no-slots",
  "-np", "1",
];
console.log(`llama-server ${args.join(" ")}`);
const child = spawn(exe, args, { stdio: "inherit", windowsHide: true });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
// process-compose の停止は taskkill /T (子も含めて止まる)。単独で止められた時のために子にも伝える
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill());
