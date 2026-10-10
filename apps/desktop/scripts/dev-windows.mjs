#!/usr/bin/env node
// Windows の開発環境の起動・停止 (Makefile.windows の up / down / ps / logs / reset から呼ぶ。Mac は Makefile が直接 process-compose を操作する)。
//
//   node apps/desktop/scripts/dev-windows.mjs up [<namespace>]   process-compose を裏で起動 (namespace 省略で全て)
//   node apps/desktop/scripts/dev-windows.mjs down              停止 (プロセスとポートが消えるまで待つ)
//   node apps/desktop/scripts/dev-windows.mjs ps                プロセス状態・ASR /health・web の応答
//   node apps/desktop/scripts/dev-windows.mjs logs <name>       プロセスのログ追従
//   node apps/desktop/scripts/dev-windows.mjs reset             dev の設定・WebView2 のデータを消す (dev-reset.sh の Windows 版。make down の後に呼ぶ)
//   node apps/desktop/scripts/dev-windows.mjs notice <key> | macos-only <target>   Makefile.windows の文言 (レシピに日本語を書けないため)
//
// process-compose (v1.122) は Windows で UDS と detached (-D) を持たない (cmd/root.go)。そのため:
// - API は TCP のループバック (127.0.0.1:MUKUCHI_PC_PORT) で受け、トークン (--token-file。%TEMP% に置く) を必須にする
//   (他のユーザー・プロセスから開発環境のプロセスを操作させないため)
// - 裏での起動は PowerShell の Start-Process -WindowStyle Hidden で行う。隠したコンソールを持たせ、子 (cmd /C ...) が
//   それを引き継ぐ (コンソールなしで起動すると子ごとにコンソールのウィンドウが開き、前面を奪うため)。端末を閉じても止まらない
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const pcDir = path.join(repoRoot, ".process-compose");
const pcYaml = path.join(repoRoot, "process-compose.windows.yaml");
const pcPort = Number(process.env.MUKUCHI_PC_PORT || 18760);
// 開発時に LISTEN するポート: llama-server / desktop の vite (strictPort) / web の vite (strictPort)。Makefile の DEV_PORTS と同じ
const ASR_PORT = 18765;
const WEB_PORT = 5174;
const DEV_PORTS = [ASR_PORT, 1420, WEB_PORT];
// clone ごとに分ける (Mac の UDS のパスと同じ考え方)
const tag = createHash("sha1").update(repoRoot.toLowerCase()).digest("hex").slice(0, 12);
const tokenFile = path.join(os.tmpdir(), `mukuchi-pc-${tag}.token`);
const pidFile = path.join(pcDir, "pc.pid");

const die = (msg, code = 1) => {
  console.error(`error: ${msg}`);
  process.exit(code);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pcArgs(...rest) {
  return ["-p", String(pcPort), "--address", "127.0.0.1", "--token-file", tokenFile, ...rest];
}

/** process-compose の API が応答するか (トークン付き) */
async function pcAlive() {
  if (!existsSync(tokenFile)) return false;
  try {
    const token = readFileSync(tokenFile, "utf8").trim();
    const res = await fetch(`http://127.0.0.1:${pcPort}/live`, {
      headers: { "X-PC-Token-Key": token },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function readPid() {
  try {
    return Number(readFileSync(pidFile, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
}

/** LISTEN 中のポート → PID (netstat。管理者権限なしで全プロセスの PID が取れる) */
function listeners(ports) {
  const r = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true });
  const r6 = spawnSync("netstat", ["-ano", "-p", "TCPv6"], { encoding: "utf8", windowsHide: true });
  const out = new Map();
  for (const line of `${r.stdout ?? ""}\n${r6.stdout ?? ""}`.split(/\r?\n/)) {
    // TCP    127.0.0.1:18765    0.0.0.0:0    LISTENING    1234 (状態の語は表示言語によらず LISTENING)
    const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/);
    if (m && ports.includes(Number(m[2]))) out.set(Number(m[3]), Number(m[2]));
  }
  return out;
}

function processName(pid) {
  const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
  return (r.stdout ?? "").split(",")[0]?.replaceAll('"', "").trim() || "?";
}

/** 開発用ポートを LISTEN しているプロセス (process-compose が落ちた後の残骸など) を表示する。残っていれば true */
function devPortLeftover() {
  const l = listeners([...DEV_PORTS, pcPort]);
  if (l.size === 0) return false;
  console.log(`開発用ポート (${[...DEV_PORTS, pcPort].join(" ")}) を使用中のプロセスが残っている:`);
  for (const [pid, port] of l) console.log(`  ${pid}  ${processName(pid)}  (tcp:${port})`);
  console.log(`  不要なら停止する: taskkill /T /F ${[...l.keys()].map((p) => `/PID ${p}`).join(" ")}`);
  return true;
}

async function up(namespace) {
  const exe = pcExe();
  mkdirSync(pcDir, { recursive: true });
  if (await pcAlive()) {
    console.log("already running (make ps / make down)");
    return;
  }
  if (devPortLeftover()) die("起動できない (make down で確認)");
  // 起動ごとに作り直す。%TEMP% は利用者だけが読める場所
  writeFileSync(tokenFile, randomBytes(24).toString("hex"), { mode: 0o600 });
  const args = pcArgs("-f", pcYaml, "-L", path.join(pcDir, "process-compose.log"), "up", "-t=false");
  if (namespace) args.push("-n", namespace);
  // Start-Process の -ArgumentList は配列を空白でつなぐだけのため、空白を含む引数は自分で引用する
  const quoted = args.map((a) => (/[\s"]/.test(a) ? `"${a.replaceAll('"', '\\"')}"` : a)).join(" ");
  const ps = [
    "$ErrorActionPreference='Stop';",
    "$p = Start-Process -PassThru -WindowStyle Hidden",
    `-FilePath ${psQuote(exe)}`,
    `-WorkingDirectory ${psQuote(repoRoot)}`,
    `-ArgumentList ${psQuote(quoted)};`,
    "$p.Id",
  ].join(" ");
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true });
  const pid = Number((r.stdout ?? "").trim());
  if (r.status !== 0 || !pid) die(`process-compose を起動できない: ${r.stderr || r.stdout}`);
  writeFileSync(pidFile, String(pid));
  // API が応答するまで待つ (Mac の -D も同じく待つ)
  for (let i = 0; i < 50; i++) {
    if (await pcAlive()) {
      console.log("started: make ps / make logs [s=asr|app|web]");
      return;
    }
    if (!pidAlive(pid)) break;
    await sleep(200);
  }
  die(`process-compose が起動しない。ログ: ${path.join(pcDir, "process-compose.log")}`);
}

/** 本体プロセスの終了と開発用ポートの解放まで待つ (最大30秒。Makefile の down と同じ) */
async function down() {
  const pid = readPid();
  if (await pcAlive()) {
    spawnSync(pcExe(), pcArgs("down"), { stdio: "ignore", windowsHide: true });
    for (let i = 0; i < 60; i++) {
      if (pidAlive(pid) || (await pcAlive()) || listeners([...DEV_PORTS, pcPort]).size > 0) {
        await sleep(500);
        continue;
      }
      break;
    }
    console.log("stopped");
  } else if (pidAlive(pid) && processName(pid).toLowerCase().startsWith("process-compose")) {
    // API が応答しない (トークンが消えた等)。記録した本体を子ごと止める
    spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    console.log(`not responding (応答しない process-compose (PID ${pid}) を子ごと停止)`);
  } else {
    console.log("not running");
  }
  rmSync(pidFile, { force: true });
  rmSync(tokenFile, { force: true });
  if (devPortLeftover()) process.exit(1);
}

async function ps() {
  if (await pcAlive()) {
    // stderr は捨てる (クライアントが設定ディレクトリの探索を debug で出すため。Makefile の ps の 2>/dev/null と同じ)
    spawnSync(pcExe(), pcArgs("process", "list", "-o", "wide"), {
      stdio: ["ignore", "inherit", "ignore"],
      windowsHide: true,
    });
  } else {
    console.log("process-compose: not running");
  }
  const get = async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      return res.ok ? await res.text() : `HTTP ${res.status}`;
    } catch {
      return null;
    }
  };
  const health = await get(`http://127.0.0.1:${ASR_PORT}/health`);
  console.log(`asr /health: ${health ?? "not responding"}`);
  const web = await get(`http://127.0.0.1:${WEB_PORT}/`);
  console.log(`web http://127.0.0.1:${WEB_PORT}/: ${web === null ? "not responding" : web.startsWith("HTTP ") ? web : "ok"}`);
}

function logs(name) {
  if (!name) die("logs <name>");
  const r = spawnSync(pcExe(), pcArgs("process", "logs", name, "-f"), { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

// ---- reset (dev-reset.sh の Windows 版) -------------------------------------------
// 意味は Mac と同じ: dev の設定・WebView2 のデータを消して次回の起動を初回起動と同じにする。models/ は常に残す。
// 導入済みの記録 (provisioned.json) は PROVISION=1、実行環境 (llama-cpu) は ALL=1 の時だけ消す (ALL=1 は記録も消す)。
// PERMISSIONS=1 (TCC) は Windows に無いため何もしない。ログ (logs/) は残す。
function reset() {
  const id = "com.minimalcorp.mukuchi.dev";
  // MUKUCHI_DEV_DATA は使わず LOCALAPPDATA から決める (上書きされていても dev の場所以外を消さないため)
  const local = process.env.LOCALAPPDATA;
  if (!local || !path.isAbsolute(local)) die("LOCALAPPDATA が無い");
  const data = path.join(local, id);
  const truthy = (v) => v === "1";
  const provision = truthy(process.env.PROVISION) || truthy(process.env.ALL);
  const all = truthy(process.env.ALL);

  // 起動中の dev のアプリ (dev-windows.ps1 や別の端末から起動したもの) が設定を書き戻さないよう、残っていれば止めさせる
  const running = devAppProcesses();
  if (running.length > 0) {
    die(`起動中の開発版を終了してから実行する:\n${running.map((p) => `  ${p.Id}  ${p.Path}`).join("\n")}`);
  }

  let removed = 0;
  const lower = (p) => path.resolve(p).toLowerCase();
  const remove = (p) => {
    if (!existsSync(p)) return;
    // 念のため: %LOCALAPPDATA% 配下で、名前に dev のバンドルIDを含むものだけ (パスは大文字小文字を区別しない)
    if (!lower(p).startsWith(lower(local) + path.sep)) die(`%LOCALAPPDATA% 外のため消さない: ${p}`);
    if (!lower(p).includes(id.toLowerCase())) die(`dev のバンドルIDを含まないため消さない: ${p}`);
    console.log(`  ${du(p).padStart(8)}  ${p}`);
    rmSync(p, { recursive: true, force: true });
    removed += 1;
  };

  console.log(`==> reset: ${id} (models/ は残す)`);
  if (existsSync(data)) {
    // データディレクトリ内: mukuchi が作った目印があるときだけ触る
    if (existsSync(path.join(data, ".mukuchi-data")) && !existsSync(path.join(data, ".git"))) {
      remove(path.join(data, "settings.json"));
      remove(path.join(data, "settings.json.tmp"));
      // 導入済みの記録を残すと、セットアップの「ダウンロード」画面は完了済みで表示され待たされない (dev-reset.sh と同じ)
      if (provision) {
        remove(path.join(data, "provisioned.json"));
        remove(path.join(data, "provisioned.json.tmp"));
      }
      // Windows の実行環境は CPU 版の llama-server だけ (Vulkan 版は同梱をそのまま使う。docs/architecture.md「識別子・パス (Windows)」)
      if (all) remove(path.join(data, "llama-cpu"));
    } else {
      console.log(`  skip: 目印 (.mukuchi-data) がないためデータディレクトリには触らない: ${data}`);
    }
    // WebView2 のデータ (Mac の ~/Library/{WebKit,Caches,HTTPStorages}/<ID> に相当)。名前に dev の ID を含む場所なので目印によらず消す
    remove(path.join(data, "EBWebView"));
  }

  if (removed === 0) console.log("  (削除するものなし)");
  if (existsSync(path.join(data, "models"))) console.log(`  kept: ${path.join(data, "models")}`);
  if (!provision) console.log("  kept: 導入済みの記録 (provisioned.json)。セットアップのダウンロードからやり直すなら PROVISION=1");
  if (!all) console.log("  kept: 実行環境 (llama-cpu)。消すなら ALL=1");
  if (truthy(process.env.PERMISSIONS)) {
    console.log("==> 権限\n  skip: Windows には TCC が無い (マイクの許可は 設定 > プライバシーとセキュリティ > マイク)。PERMISSIONS=1 は無視する");
  }
}

/** このリポジトリでビルドした dev のアプリ (target 配下の mukuchi.exe) で起動中のもの */
function devAppProcesses() {
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", "Get-Process mukuchi -ErrorAction SilentlyContinue | Select-Object Id,Path | ConvertTo-Json -Compress"],
    { encoding: "utf8", windowsHide: true },
  );
  const out = (r.stdout ?? "").trim();
  if (!out) return [];
  const list = [].concat(JSON.parse(out));
  const target = path.join(repoRoot, "apps/desktop/src-tauri/target").toLowerCase();
  return list.filter((p) => p.Path && p.Path.toLowerCase().startsWith(target));
}

function du(p) {
  let n = 0;
  const walk = (q) => {
    const s = statSync(q, { throwIfNoEntry: false });
    if (!s) return;
    if (s.isDirectory()) {
      for (const e of readdirSafe(q)) walk(path.join(q, e));
    } else n += s.size;
  };
  walk(p);
  return n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)}M` : `${(n / 1024).toFixed(0)}K`;
}

function readdirSafe(p) {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

function which(cmd) {
  const r = spawnSync("where", [cmd], { encoding: "utf8", windowsHide: true });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
}

function pcExe() {
  return which("process-compose") ?? die("process-compose が PATH に無い。apps/desktop/scripts/install-dev-tools-windows.ps1 で入れる");
}

const psQuote = (s) => `'${String(s).replaceAll("'", "''")}'`;

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "up":
    await up(arg);
    break;
  case "down":
    await down();
    break;
  case "ps":
    await ps();
    break;
  case "logs":
    logs(arg);
    break;
  case "reset":
    reset();
    break;
  // make のレシピに日本語を書くと文字化けするため (Makefile.windows)、文言はここから出す
  case "notice":
    console.log(
      {
        help: "  (Windows: make・process-compose は apps/desktop/scripts/install-dev-tools-windows.ps1 で導入。build 系は macOS 専用)",
        "skip-ruff": "skip: asr-server の ruff (Windows では uv を使わない。Mac・CI で検査される)",
        "skip-pytest": "skip: asr-server の pytest (Windows では uv を使わない。Mac・CI で検査される)",
      }[arg] ?? arg,
    );
    break;
  case "macos-only":
    die(
      `make ${arg} は macOS 専用 (Developer ID 署名・公証・.dmg)。Windows のパッケージ (NSIS) は Phase 4 で実装予定 (docs/plans/windows-plan.md)`,
    );
    break;
  default:
    die("usage: dev-windows.mjs up [<namespace>] | down | ps | logs <name> | reset", 2);
}
