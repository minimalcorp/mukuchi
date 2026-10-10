#!/usr/bin/env node
// Windows 版のインストーラー (NSIS、署名なし) を作る。make build / build-local (Makefile.windows)・
// .github/workflows/release.yml (build-windows)・ci.yml (desktop-windows) が使う。Windows ネイティブ専用。
//
//   node apps/desktop/scripts/build-windows.mjs [--no-blockers] [--verify-wav <file>] [--placeholder-verify-wav]
//
//   1. scripts/check-release-blockers.mjs desktop (配布してはいけない仮の値。--no-blockers で省く: build-local・CI)
//   2. 同梱物: llama-server (+ VC++ ランタイム。fetch-llama-server.mjs)、verify.wav
//      (--verify-wav のファイル > 既存の bundle-resources/verify.wav > make-verify-wav.ps1 (日本語 SAPI 音声 Haruka) の順。
//       --placeholder-verify-wav は空のファイルを置く: CI のビルド確認用。配布物には使わない)
//   3. 依存の確認 (check-windows-dlls.mjs): llama-server/ のグループ
//   4. tauri build --bundles nsis (署名しない。Authenticode の証明書が無いため。docs/release.md の「Windows」)
//   5. 依存の確認: インストール先の直下のグループ (mukuchi.exe + vc-runtime/)。NSIS のスクリプトに同梱物がすべて入っていること
//   6. <target>/release/bundle/windows-release/ に版なしの名前 mukuchi_x64-setup.exe と .sha256 を置く (LP の固定 URL 用)
//
// Node の標準ライブラリだけを使う。
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APP_VC } from "./fetch-vc-runtime.mjs";
import { checkGroup } from "./check-windows-dlls.mjs";

if (process.platform !== "win32") {
  console.error("build-windows: Windows ネイティブで実行する (WSL・macOS は不可)");
  process.exit(1);
}

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(desktop, "../..");
const tauriDir = path.join(desktop, "src-tauri");
const resources = path.join(tauriDir, "bundle-resources");
const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const value = (k) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : undefined);
for (const a of args) {
  if (a.startsWith("--") && !["--no-blockers", "--verify-wav", "--placeholder-verify-wav"].includes(a)) {
    console.error(`build-windows: 不明な引数 ${a}`);
    process.exit(2);
  }
}

// 成果物の名前 (版なし。LP の releases/latest/download/mukuchi_x64-setup.exe と release.yml がこの名前を使う)
const SETUP_NAME = "mukuchi_x64-setup.exe";

const step = (m) => console.error(`==> ${m}`);
function die(m) {
  console.error(`error: ${m}`);
  process.exit(1);
}
function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: "inherit", cwd: desktop, shell: opts.shell ?? false, ...opts });
  if (r.error) die(`${cmd} を起動できない: ${r.error.message}`);
  if (r.status !== 0) die(`${cmd} ${argv.join(" ")} が失敗 (${r.status})`);
}
const sha256 = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

const version = JSON.parse(readFileSync(path.join(tauriDir, "tauri.conf.json"), "utf8")).version;
const productName = JSON.parse(readFileSync(path.join(tauriDir, "tauri.conf.json"), "utf8")).productName;
const target = process.env.CARGO_TARGET_DIR ? path.resolve(process.env.CARGO_TARGET_DIR) : path.join(tauriDir, "target");
const release = path.join(target, "release");

const started = Date.now();

// 1. 仮の値
if (!flag("--no-blockers")) {
  step("check-release-blockers");
  run(process.execPath, [path.join(repo, "scripts/check-release-blockers.mjs"), "desktop"]);
}

// 2. 同梱物
step("bundle resources (llama-server, VC++ runtime, verify.wav)");
run(process.execPath, [path.join(desktop, "scripts/fetch-llama-server.mjs")], { stdio: ["ignore", "ignore", "inherit"] });
const verifyWav = path.join(resources, "verify.wav");
if (value("--verify-wav")) {
  const src = path.resolve(value("--verify-wav"));
  if (!existsSync(src) || statSync(src).size === 0) die(`--verify-wav ${src} が無いか空`);
  copyFileSync(src, verifyWav);
} else if (flag("--placeholder-verify-wav")) {
  writeFileSync(verifyWav, "");
} else if (!existsSync(verifyWav) || statSync(verifyWav).size === 0) {
  run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "scripts\\make-verify-wav.ps1", "-Out", "src-tauri\\bundle-resources\\verify.wav"]);
}
// 配布物に空の verify.wav を入れない (セットアップの動作確認が必ず失敗する)
if (!flag("--placeholder-verify-wav") && statSync(verifyWav).size < 1000) die(`${verifyWav} が空に近い (${statSync(verifyWav).size} バイト)`);

// 3. llama-server/ の依存
function checkDlls(paths) {
  const r = checkGroup(paths);
  if (r.problems.length > 0) die(`依存を解決できない:\n  ${r.problems.join("\n  ")}`);
  console.error(`    OK: ${r.files.length} ファイル (${paths.map((p) => path.relative(desktop, p) || p).join(", ")})`);
}
step("check-windows-dlls: llama-server/");
checkDlls([path.join(resources, "llama-server")]);

// 4. NSIS
step(`tauri build --bundles nsis (v${version})`);
const nsisDir = path.join(release, "bundle/nsis");
const builtName = `${productName}_${version}_x64-setup.exe`;
rmSync(path.join(nsisDir, builtName), { force: true });
// pnpm は pnpm.cmd のためシェル経由。固定の文字列だけを渡す (引数の配列とシェルの併用は Node が非推奨にしている: DEP0190)
run("pnpm exec tauri build --bundles nsis --ci", [], { shell: true });
const built = path.join(nsisDir, builtName);
// tauri-bundler 2.x (cli 2.12.0) の名前は "<productName>_<version>_<arch>-setup.exe" (bundle/windows/nsis/mod.rs)
if (!existsSync(built)) {
  die(`${built} が無い (あるもの: ${existsSync(nsisDir) ? readdirSync(nsisDir).join(", ") : "なし"})。tauri の成果物名が変わった?`);
}

// 5. インストール先の直下の依存・NSIS のスクリプトに同梱物が入っていること
step("check-windows-dlls: mukuchi.exe + vc-runtime/");
checkDlls([path.join(release, "mukuchi.exe"), ...APP_VC.map((n) => path.join(resources, "vc-runtime", n))]);

step("NSIS の同梱物");
const nsi = readFileSync(path.join(release, "nsis/x64/installer.nsi"), "utf8");
// tauri の installer.nsi は resources を `File /a "/oname=<インストール先からの相対パス>" "<元>"` で書く
const packed = new Set([...nsi.matchAll(/File \/a "\/oname=([^"]+)"/g)].map((m) => m[1].replaceAll("\\", "/").toLowerCase()));
const expected = [
  ...readdirSync(path.join(resources, "llama-server")).map((n) => `llama-server/${n}`),
  ...APP_VC,
  "verify.wav",
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES",
  "licenses/silero-vad-LICENSE",
];
const missing = expected.filter((p) => !packed.has(p.toLowerCase()));
if (missing.length > 0) die(`インストーラーに入っていない: ${missing.join(", ")}`);
if (!/File "\$\{MAINBINARYSRCPATH\}"/.test(nsi)) die("インストーラーに mukuchi.exe が入っていない");
// アンインストールのフック (src-tauri/windows/installer-hooks.nsh。データの削除・StartupApproved) が入っていること
if (!/!include "[^"]*installer-hooks\.nsh"/.test(nsi)) die("インストーラーに installer-hooks.nsh が入っていない");
console.error(`    OK: ${packed.size} ファイル + mukuchi.exe`);

// 6. 版なしの名前で置く
const out = path.join(release, "bundle/windows-release");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const setup = path.join(out, SETUP_NAME);
copyFileSync(built, setup);
// .sha256 は添付のファイル名で書く (ダウンロードした名前のまま sha256sum -c で確かめられるように。Mac の .dmg と同じ)
writeFileSync(`${setup}.sha256`, `${sha256(setup)}  ${SETUP_NAME}\n`);
const mb = (statSync(setup).size / 1024 / 1024).toFixed(1);
step(`${setup} (${mb} MiB, ${Math.round((Date.now() - started) / 1000)}s)`);
console.log(setup);
