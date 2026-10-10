// node --test scripts/ で実行する。鍵は scripts/fixtures/updater-test-key/ のテスト専用の鍵 (本番の鍵ではない)。
// tauri signer (minisign crate 0.9.1) は Ed25519 の nonce に乱数を混ぜるため、同じ入力でも署名のバイト列は毎回変わる。
// そのため「署名の2か所 (本体・global) 以外が tauri signer の出力と一致する」ことと「互いの署名が同じ公開鍵で検証できる」
// ことを確かめる
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  blake2b,
  decodePublicKey,
  decodeSecretKey,
  latestJson,
  PLATFORMS,
  prehashFile,
  rfc3339,
  scryptParams,
  signPrehashed,
  trustedComment,
  verifySignature,
} from "./sign-updater.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = path.join(here, "fixtures/updater-test-key");
const KEY = readFileSync(path.join(fx, "test-only.key"), "utf8");
const PUB = readFileSync(path.join(fx, "test-only.key.pub"), "utf8");
const PASSWORD = "mukuchi-test-only";
const DATA = path.join(fx, "mukuchi_aarch64.app.tar.gz");
const TAURI_SIG = readFileSync(path.join(fx, "tauri-signer.sig"), "utf8");

const lines = (sigB64) => Buffer.from(sigB64, "base64").toString("utf8").split("\n");

test("BLAKE2b: Node の blake2b512 と一致し、256 は既知の値", () => {
  for (const n of [0, 1, 127, 128, 129, 255, 256, 1000]) {
    const d = randomBytes(n);
    assert.deepEqual(blake2b(d, 64), createHash("blake2b512").update(d).digest(), `len ${n}`);
  }
  // RFC 7693 の実装 (libsodium・b2sum -l 256) の値
  assert.equal(
    blake2b(Buffer.alloc(0), 32).toString("hex"),
    "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8",
  );
  assert.equal(
    blake2b(Buffer.from("abc"), 32).toString("hex"),
    "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319",
  );
});

test("scrypt のパラメータ: tauri signer generate の既定 (opslimit 2^20, memlimit 2^25) は N=2^15, r=8, p=1", () => {
  assert.deepEqual(scryptParams(1048576n, 33554432n), { N: 32768, r: 8, p: 1 });
  assert.throws(() => scryptParams(1n << 40n, 1n << 31n));
});

test("秘密鍵の復号: 公開鍵と対になり、パスワード違いは失敗する", () => {
  const key = decodeSecretKey(KEY, PASSWORD);
  const pub = decodePublicKey(PUB);
  assert.deepEqual(key.keynum, Buffer.from(pub.keynum));
  assert.deepEqual(key.publicKey, Buffer.from(pub.publicKey));
  // .pub のコメントの鍵 ID は keynum を u64 LE として表示したもの
  const id = Buffer.from(PUB, "base64").toString("utf8").match(/public key: ([0-9A-F]{16})/)[1];
  assert.equal(key.keynum.readBigUInt64LE(0).toString(16).toUpperCase().padStart(16, "0"), id);
  assert.throws(() => decodeSecretKey(KEY, "wrong"), /パスワードが違う/);
  assert.throws(() => decodeSecretKey(KEY.slice(0, 40), PASSWORD));
  // secret に貼った時の末尾の改行は許す
  assert.doesNotThrow(() => decodeSecretKey(`${KEY.trim()}\n`, PASSWORD));
});

test("tauri signer の出力を検証できる (形式の解釈が一致)", async () => {
  const prehash = await prehashFile(DATA);
  const comment = verifySignature(TAURI_SIG, PUB, prehash);
  assert.match(comment, /^timestamp:\d+\tfile:mukuchi_aarch64\.app\.tar\.gz\tversion:1\.2\.3$/);
  // 中身を変えると失敗する
  const other = createHash("blake2b512").update("tampered").digest();
  assert.throws(() => verifySignature(TAURI_SIG, PUB, other), /一致しない/);
});

test("同じ trusted comment なら、署名の2か所以外は tauri signer の出力と同じ", async () => {
  const prehash = await prehashFile(DATA);
  const tauri = lines(TAURI_SIG);
  const comment = tauri[2].slice("trusted comment: ".length);
  const ts = Number(/^timestamp:(\d+)/.exec(comment)[1]);
  assert.equal(trustedComment({ timestamp: ts, fileName: "mukuchi_aarch64.app.tar.gz", version: "1.2.3" }), comment);

  const ours = signPrehashed(prehash, decodeSecretKey(KEY, PASSWORD), comment);
  const mine = lines(ours);
  assert.equal(mine.length, tauri.length);
  assert.equal(mine[0], tauri[0]); // untrusted comment
  assert.equal(mine[2], tauri[2]); // trusted comment
  assert.equal(mine[4], ""); // 末尾の改行
  // 署名本体: "ED" + keynum (10 バイト) は同じ、Ed25519 の 64 バイトだけ違いうる
  const a = Buffer.from(mine[1], "base64");
  const b = Buffer.from(tauri[1], "base64");
  assert.equal(a.length, 74);
  assert.deepEqual(a.subarray(0, 10), b.subarray(0, 10));
  assert.equal(Buffer.from(mine[3], "base64").length, 64);
  // .sig 全体は改行なしの base64 1行
  assert.match(ours, /^[A-Za-z0-9+/]+={0,2}$/);
  assert.equal(verifySignature(ours, PUB, prehash), comment);
  // RFC 8032 の Ed25519 は決定的 (同じ入力なら同じ署名)
  assert.equal(signPrehashed(prehash, decodeSecretKey(KEY, PASSWORD), comment), ours);
});

test("trusted comment を書き換えると global signature で失敗する", async () => {
  const prehash = await prehashFile(DATA);
  const comment = trustedComment({ timestamp: 1, fileName: "mukuchi_aarch64.app.tar.gz", version: "1.2.3" });
  const l = lines(signPrehashed(prehash, decodeSecretKey(KEY, PASSWORD), comment));
  l[2] = l[2].replace("version:1.2.3", "version:9.9.9");
  const tampered = Buffer.from(l.join("\n")).toString("base64");
  assert.throws(() => verifySignature(tampered, PUB, prehash), /global signature/);
});

test("trusted comment にタブ・改行を入れない", () => {
  assert.throws(() => trustedComment({ timestamp: 1, fileName: "a\tb", version: "1.0.0" }));
  assert.throws(() => trustedComment({ timestamp: 1, fileName: "a", version: "1.0.0\nx" }));
});

test("latest.json: 両プラットフォームを PLATFORMS の順に書く", () => {
  const mac = "https://github.com/minimalcorp/mukuchi/releases/download/desktop-v1.2.3/mukuchi_aarch64.app.tar.gz";
  const win = "https://github.com/minimalcorp/mukuchi/releases/download/desktop-v1.2.3/mukuchi_x64-setup.exe";
  const pubDate = "2026-10-02T00:00:00Z";
  // 渡す順によらず darwin-aarch64 → windows-x86_64 の順
  const text = latestJson({
    version: "1.2.3",
    platforms: { "windows-x86_64": { signature: "W", url: win }, "darwin-aarch64": { signature: "M", url: mac } },
    pubDate,
  });
  assert.deepEqual(JSON.parse(text), {
    version: "1.2.3",
    pub_date: pubDate,
    platforms: { "darwin-aarch64": { signature: "M", url: mac }, "windows-x86_64": { signature: "W", url: win } },
  });
  assert.deepEqual(Object.keys(JSON.parse(text).platforms), ["darwin-aarch64", "windows-x86_64"]);
  assert.deepEqual(PLATFORMS, ["darwin-aarch64", "windows-x86_64"]);
  // 1 プラットフォームだけでも書ける (手元の確認用)
  assert.deepEqual(Object.keys(JSON.parse(latestJson({ version: "1.2.3", platforms: { "darwin-aarch64": { signature: "M", url: mac } }, pubDate })).platforms), ["darwin-aarch64"]);
  const one = { "darwin-aarch64": { signature: "S", url: mac } };
  assert.throws(() => latestJson({ version: "1.2", platforms: one, pubDate }));
  assert.throws(() => latestJson({ version: "1.2.3", platforms: { "darwin-aarch64": { signature: "S", url: mac.replace("https", "http") } }, pubDate }));
  assert.throws(() => latestJson({ version: "1.2.3", platforms: {}, pubDate }), /空/);
  assert.throws(() => latestJson({ version: "1.2.3", platforms: { "linux-x86_64": { signature: "S", url: mac } }, pubDate }), /未知/);
  assert.equal(rfc3339(new Date(Date.UTC(2026, 9, 2, 1, 2, 3, 456))), "2026-10-02T01:02:03Z");
});

test("CLI: 両プラットフォームの .sig と latest.json を書き、tauri.conf.json の公開鍵と対でない鍵は拒否する", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "mukuchi-sign-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const conf = path.join(dir, "tauri.conf.json");
  writeFileSync(conf, JSON.stringify({ plugins: { updater: { pubkey: PUB } } }));
  // Windows の更新物 (NSIS のインストーラー) の代わり。中身は何でもよい (署名はバイト列に対して行う)
  const exe = path.join(dir, "mukuchi_x64-setup.exe");
  writeFileSync(exe, Buffer.concat([Buffer.from("MZ"), randomBytes(4096)]));
  const base = "https://github.com/minimalcorp/mukuchi/releases/download/desktop-v1.2.3";
  const mac = `${base}/mukuchi_aarch64.app.tar.gz`;
  const win = `${base}/mukuchi_x64-setup.exe`;
  const out = path.join(dir, "out");
  mkdirSync(out);
  const common = ["--version", "1.2.3", "--pubkey-config", conf, "--out", out, "--timestamp", "1790000000"];
  const args = [
    path.join(here, "sign-updater.mjs"),
    ...["--file", `darwin-aarch64=${DATA}`, "--url", `darwin-aarch64=${mac}`],
    ...["--file", `windows-x86_64=${exe}`, "--url", `windows-x86_64=${win}`],
    ...common,
  ];
  const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: KEY, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: PASSWORD };
  execFileSync(process.execPath, args, { env, stdio: "pipe" });
  const macSig = readFileSync(path.join(out, "mukuchi_aarch64.app.tar.gz.sig"), "utf8");
  const winSig = readFileSync(path.join(out, "mukuchi_x64-setup.exe.sig"), "utf8");
  const j = JSON.parse(readFileSync(path.join(out, "latest.json"), "utf8"));
  assert.equal(j.version, "1.2.3");
  assert.equal(j.pub_date, "2026-09-21T14:13:20Z");
  assert.deepEqual(j.platforms, {
    "darwin-aarch64": { signature: macSig, url: mac },
    "windows-x86_64": { signature: winSig, url: win },
  });
  assert.equal(lines(macSig)[2], "trusted comment: timestamp:1790000000\tfile:mukuchi_aarch64.app.tar.gz\tversion:1.2.3");
  assert.equal(lines(winSig)[2], "trusted comment: timestamp:1790000000\tfile:mukuchi_x64-setup.exe\tversion:1.2.3");
  // それぞれ自分のファイルでだけ検証できる (取り違えていない)
  assert.ok(verifySignature(winSig, PUB, await prehashFile(exe)));
  const macHash = await prehashFile(DATA);
  assert.throws(() => verifySignature(winSig, PUB, macHash), /一致しない/);

  const run = (a, e = env) => execFileSync(process.execPath, a, { env: e, stdio: "pipe" });
  const fresh = () => {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out);
  };
  // 対でない公開鍵 (公開鍵を1バイト変えたもの) を tauri.conf.json に置くと止まり、何も書かない
  const raw = Buffer.from(PUB, "base64").toString("utf8").split("\n");
  const bin = Buffer.from(raw[1], "base64");
  bin[41] ^= 1;
  raw[1] = bin.toString("base64");
  writeFileSync(conf, JSON.stringify({ plugins: { updater: { pubkey: Buffer.from(raw.join("\n")).toString("base64") } } }));
  fresh();
  assert.throws(() => run(args), /対でない/);
  assert.deepEqual(readdirSync(out), []);
  writeFileSync(conf, JSON.stringify({ plugins: { updater: { pubkey: PUB } } }));
  // url のファイル名が違う (片方だけでも) と止まり、何も書かない
  fresh();
  assert.throws(() => run(args.map((a) => (a === `windows-x86_64=${win}` ? `windows-x86_64=${base}/other.exe` : a))), /ファイル名/);
  assert.deepEqual(readdirSync(out), []);
  // パスワード違い
  assert.throws(() => run(args, { ...env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "x" }), /パスワード/);
  // --file と --url が対でない・未知のプラットフォーム・プラットフォームなし・重複
  const sign = path.join(here, "sign-updater.mjs");
  assert.throws(() => run([sign, "--file", `windows-x86_64=${exe}`, ...common]), /対で/);
  assert.throws(() => run([sign, "--file", `linux-x86_64=${exe}`, "--url", `linux-x86_64=${win}`, ...common]), /の形/);
  assert.throws(() => run([sign, "--file", exe, "--url", win, ...common]), /の形/);
  assert.throws(() => run([sign, ...common]), /--file が必要/);
  assert.throws(
    () => run([sign, "--file", `windows-x86_64=${exe}`, "--file", `windows-x86_64=${exe}`, "--url", `windows-x86_64=${win}`, ...common]),
    /2 回/,
  );
});
