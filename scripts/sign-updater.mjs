#!/usr/bin/env node
// tauri-plugin-updater 用の署名 (.sig) と latest.json を作る。.github/workflows/release.yml の publish-desktop が使う。
// Node の標準ライブラリだけを使う (署名鍵を読む job で第三者のコード (tauri-cli・minisign) を動かさないため)。
//
//   TAURI_SIGNING_PRIVATE_KEY=<鍵ファイルの中身> TAURI_SIGNING_PRIVATE_KEY_PASSWORD=<パスワード> \
//   node scripts/sign-updater.mjs --version <X.Y.Z> --pubkey-config <tauri.conf.json> --out <dir> \
//     --file darwin-aarch64=<mukuchi_aarch64.app.tar.gz> --url darwin-aarch64=<配布 URL> \
//     --file windows-x86_64=<mukuchi_x64-setup.exe> --url windows-x86_64=<配布 URL> \
//     [--pub-date <RFC3339>] [--timestamp <unix秒>]
//
// プラットフォーム (latest.json の platforms のキー) ごとに --file と --url を 1 つずつ渡す (1 つ以上。PLATFORMS のみ)。
// 各ファイルの <dir>/<file名>.sig (tauri signer sign と同じ形) と、全プラットフォームを載せた <dir>/latest.json を書く。
// 書く前に tauri.conf.json の plugins.updater.pubkey で検証する (アプリに入っている公開鍵と違う鍵で署名した更新は
// 誰にも入れられないため)。Mac と Windows は同じ鍵・同じ版で署名する (1 つの Release・1 つの latest.json のため)。
//
// 形式 (tauri-cli 2.12.0 が使う minisign crate 0.9.1 と同じ。根拠は docs/release.md の「アップデートの署名」):
//   鍵ファイル: base64( "untrusted comment: ...\n" + base64(秘密鍵) + "\n" )
//     秘密鍵 = sig_alg "Ed" | kdf_alg "Sc" | chk_alg "B2" | salt 32 | opslimit u64le | memlimit u64le
//              | (keynum 8 | sk 64 (seed 32 + 公開鍵 32) | chk 32) を scrypt の出力 104 バイトと XOR したもの
//     chk = BLAKE2b-256(sig_alg | keynum | sk)。一致しなければパスワード違い
//   署名: prehashed Ed25519 (sig_alg "ED")。本体 = Ed25519(BLAKE2b-512(ファイル))、
//         global = Ed25519(本体の64バイト | trusted comment)
//   .sig: base64( "untrusted comment: signature from tauri secret key\n" + base64("ED"|keynum|本体) + "\n"
//                 + "trusted comment: " + tc + "\n" + base64(global) + "\n" )
//   trusted comment: "timestamp:<unix秒>\tfile:<ファイル名>\tversion:<版>" (requireSignedVersion がこの version を見る)
// minisign crate は Ed25519 の nonce に乱数を混ぜる (hedged) が、ここは RFC 8032 どおり決定的に署名する。
// どちらも同じ公開鍵で検証でき、検証側 (minisign-verify) は nonce の作り方に依存しない。
import { createHash, createPrivateKey, createPublicKey, scryptSync, sign, verify } from "node:crypto";
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// latest.json の platforms のキー。tauri-plugin-updater 2.13 は "{os}-{arch}-{installer}" → "{os}-{arch}" の順に探す
// (updater.rs の get_urls。macOS は darwin-aarch64-app、Windows の NSIS は windows-x86_64-nsis)。後者だけにすると、
// バンドルの種類の判定によらず見つかる。Windows は NSIS のインストーラー (.exe) そのものが更新物
// (updater.rs の extract_exe: PE なら NSIS として /UPDATE 付きで起動する)
export const PLATFORMS = ["darwin-aarch64", "windows-x86_64"];
const UNTRUSTED_COMMENT = "signature from tauri secret key";

// ---- BLAKE2b (RFC 7693) --------------------------------------------------------------------------
// 鍵のチェックサムは BLAKE2b-256 (出力長を変えると初期値が変わり、BLAKE2b-512 の切り詰めとは別物)。
// Node の crypto は blake2b512 しか持たないため、短い入力用にここで実装する (BigInt で遅いが 1 ブロック程度)
const M64 = (1n << 64n) - 1n;
const B2_IV = [
  0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
];
const B2_SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const rotr = (x, n) => ((x >> n) | (x << (64n - n))) & M64;

export function blake2b(data, outlen) {
  if (!(outlen >= 1 && outlen <= 64)) throw new Error("blake2b: outlen は 1..64");
  const h = B2_IV.slice();
  h[0] ^= 0x01010000n ^ BigInt(outlen);
  const nblocks = Math.max(1, Math.ceil(data.length / 128));
  for (let b = 0; b < nblocks; b++) {
    const block = Buffer.alloc(128);
    data.copy(block, 0, b * 128, Math.min(data.length, (b + 1) * 128));
    const last = b === nblocks - 1;
    const t = BigInt(last ? data.length : (b + 1) * 128);
    const m = Array.from({ length: 16 }, (_, i) => block.readBigUInt64LE(i * 8));
    const v = [...h, ...B2_IV];
    v[12] ^= t & M64;
    v[13] ^= t >> 64n;
    if (last) v[14] ^= M64;
    const g = (a, bb, c, d, x, y) => {
      v[a] = (v[a] + v[bb] + x) & M64;
      v[d] = rotr(v[d] ^ v[a], 32n);
      v[c] = (v[c] + v[d]) & M64;
      v[bb] = rotr(v[bb] ^ v[c], 24n);
      v[a] = (v[a] + v[bb] + y) & M64;
      v[d] = rotr(v[d] ^ v[a], 16n);
      v[c] = (v[c] + v[d]) & M64;
      v[bb] = rotr(v[bb] ^ v[c], 63n);
    };
    for (let r = 0; r < 12; r++) {
      const s = B2_SIGMA[r % 10];
      g(0, 4, 8, 12, m[s[0]], m[s[1]]);
      g(1, 5, 9, 13, m[s[2]], m[s[3]]);
      g(2, 6, 10, 14, m[s[4]], m[s[5]]);
      g(3, 7, 11, 15, m[s[6]], m[s[7]]);
      g(0, 5, 10, 15, m[s[8]], m[s[9]]);
      g(1, 6, 11, 12, m[s[10]], m[s[11]]);
      g(2, 7, 8, 13, m[s[12]], m[s[13]]);
      g(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let i = 0; i < 8; i++) h[i] ^= v[i] ^ v[i + 8];
  }
  const out = Buffer.alloc(64);
  h.forEach((x, i) => out.writeBigUInt64LE(x, i * 8));
  return out.subarray(0, outlen);
}

// ---- 鍵 -----------------------------------------------------------------------------------------

// 厳密な base64 (改行・前後の空白だけは許す。secret に貼る時に付きやすいため)。Buffer.from は不正な文字を黙って捨てる
function b64decode(s, what) {
  const t = String(s).replace(/\s+/g, "");
  if (!t || !/^[A-Za-z0-9+/]+={0,2}$/.test(t) || t.length % 4 !== 0) {
    throw new Error(`${what} が base64 でない`);
  }
  return Buffer.from(t, "base64");
}

// minisign の box (1行目がコメント、2行目が base64) の2行目
function boxPayload(text, what) {
  const lines = text.split("\n");
  if (lines.length < 2 || !lines[0].startsWith("untrusted comment: ")) {
    throw new Error(`${what} が minisign の形式でない`);
  }
  return b64decode(lines[1], what);
}

// minisign crate (helpers.rs の raw_scrypt_params) と同じ方法で opslimit・memlimit から N・r・p を決める
export function scryptParams(opslimit, memlimit) {
  const MEMLIMIT_MAX = 1_073_741_824n;
  const N_LOG2_MAX = 20;
  if (memlimit > MEMLIMIT_MAX) throw new Error("scrypt のパラメータが大きすぎる");
  const ops = opslimit < 32768n ? 32768n : opslimit;
  const r = 8n;
  let nLog2 = 1;
  let p;
  if (ops < memlimit / 32n) {
    p = 1n;
    const maxn = ops / (r * 4n);
    while (nLog2 < 63 && !(1n << BigInt(nLog2) > maxn / 2n)) nLog2++;
  } else {
    const maxn = memlimit / (r * 128n);
    while (nLog2 < 63 && !(1n << BigInt(nLog2) > maxn / 2n)) nLog2++;
    let maxrp = ops / 4n / (1n << BigInt(nLog2));
    if (maxrp > 0x3fffffffn) maxrp = 0x3fffffffn;
    p = maxrp / r;
  }
  if (nLog2 > N_LOG2_MAX) throw new Error("scrypt のパラメータが大きすぎる");
  if (p < 1n) throw new Error("scrypt の p が 0");
  return { N: 2 ** nLog2, r: Number(r), p: Number(p) };
}

// tauri の秘密鍵 (TAURI_SIGNING_PRIVATE_KEY = 鍵ファイルの中身) を復号する
export function decodeSecretKey(keyB64, password) {
  const raw = boxPayload(b64decode(keyB64, "秘密鍵").toString("utf8"), "秘密鍵");
  if (raw.length !== 158) throw new Error(`秘密鍵の長さが想定と違う (${raw.length})`);
  const sigAlg = raw.subarray(0, 2).toString("latin1");
  const kdfAlg = raw.subarray(2, 4).toString("latin1");
  const chkAlg = raw.subarray(4, 6).toString("latin1");
  if (sigAlg !== "Ed" || chkAlg !== "B2") throw new Error(`未対応の秘密鍵 (${sigAlg}/${chkAlg})`);
  // 104 = keynum 8 + sk 64 + chk 32
  const enc = Buffer.from(raw.subarray(54, 158));
  if (kdfAlg === "Sc") {
    const salt = raw.subarray(6, 38);
    const { N, r, p } = scryptParams(raw.readBigUInt64LE(38), raw.readBigUInt64LE(46));
    // Node の scrypt は 128*N*r が maxmem を超えると失敗する (既定 32MiB は tauri の鍵 (N=2^15, r=8) でちょうど超える)
    const maxmem = 128 * N * r + 128 * r * p + 16 * 1024 * 1024;
    const stream = scryptSync(Buffer.from(password, "utf8"), salt, 104, { N, r, p, maxmem });
    for (let i = 0; i < 104; i++) enc[i] ^= stream[i];
  } else if (kdfAlg !== "\0\0") {
    throw new Error(`未対応の暗号化方式 (${JSON.stringify(kdfAlg)})`);
  }
  const keynum = enc.subarray(0, 8);
  const sk = enc.subarray(8, 72);
  const chk = enc.subarray(72, 104);
  const want = blake2b(Buffer.concat([Buffer.from("Ed"), keynum, sk]), 32);
  if (!want.equals(chk)) throw new Error("秘密鍵のパスワードが違う (チェックサムが一致しない)");
  const seed = sk.subarray(0, 32);
  const pk = sk.subarray(32, 64);
  const privateKey = createPrivateKey({
    key: { kty: "OKP", crv: "Ed25519", d: seed.toString("base64url"), x: pk.toString("base64url") },
    format: "jwk",
  });
  // seed から導いた公開鍵が鍵ファイル内の公開鍵と一致することも確かめる
  const derived = Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
  if (!derived.equals(pk)) throw new Error("秘密鍵が壊れている (公開鍵が一致しない)");
  return { keynum: Buffer.from(keynum), publicKey: Buffer.from(pk), privateKey };
}

// tauri の公開鍵 (tauri.conf.json の plugins.updater.pubkey)
export function decodePublicKey(pubB64) {
  const raw = boxPayload(b64decode(pubB64, "公開鍵").toString("utf8"), "公開鍵");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") {
    throw new Error("公開鍵が minisign の Ed25519 公開鍵でない");
  }
  return { keynum: raw.subarray(2, 10), publicKey: raw.subarray(10, 42) };
}

function publicKeyObject(pk) {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pk.toString("base64url") }, format: "jwk" });
}

// ---- 署名 ---------------------------------------------------------------------------------------

export function trustedComment({ timestamp, fileName, version }) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error(`timestamp が不正: ${timestamp}`);
  // trusted comment はタブ区切りの1行 (tauri-cli の sign_file と同じ制約)
  for (const [k, v] of [["ファイル名", fileName], ["版", version]]) {
    if (!v || /[\t\r\n]/.test(v)) throw new Error(`${k} が空かタブ・改行を含む: ${JSON.stringify(v)}`);
  }
  return `timestamp:${timestamp}\tfile:${fileName}\tversion:${version}`;
}

export async function prehashFile(file) {
  const h = createHash("blake2b512");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest();
}

// prehash (BLAKE2b-512) 済みのデータに署名し、.sig の中身 (tauri と同じく box 全体を base64 にしたもの) を返す
export function signPrehashed(prehash, key, comment) {
  const sig = sign(null, prehash, key.privateKey);
  const global = sign(null, Buffer.concat([sig, Buffer.from(comment, "utf8")]), key.privateKey);
  const box =
    `untrusted comment: ${UNTRUSTED_COMMENT}\n` +
    `${Buffer.concat([Buffer.from("ED"), key.keynum, sig]).toString("base64")}\n` +
    `trusted comment: ${comment}\n` +
    `${global.toString("base64")}\n`;
  return Buffer.from(box, "utf8").toString("base64");
}

// .sig を公開鍵で検証し、trusted comment を返す (minisign-verify と同じ手順: 鍵 ID・本体・global)
export function verifySignature(sigB64, pubB64, prehash) {
  const { keynum, publicKey } = decodePublicKey(pubB64);
  const lines = b64decode(sigB64, "署名").toString("utf8").split("\n");
  if (lines.length < 4 || !lines[0].startsWith("untrusted comment: ")) throw new Error("署名の形式が違う");
  const bin = b64decode(lines[1], "署名本体");
  if (bin.length !== 74) throw new Error("署名本体の長さが違う");
  if (bin.subarray(0, 2).toString("latin1") !== "ED") throw new Error("prehashed (ED) の署名でない");
  if (!bin.subarray(2, 10).equals(keynum)) throw new Error("署名の鍵 ID が公開鍵と違う");
  if (!lines[2].startsWith("trusted comment: ")) throw new Error("trusted comment がない");
  const comment = lines[2].slice("trusted comment: ".length);
  const global = b64decode(lines[3], "global signature");
  const pko = publicKeyObject(publicKey);
  const sig = bin.subarray(10);
  if (!verify(null, prehash, pko, sig)) throw new Error("署名がファイルと一致しない");
  if (!verify(null, Buffer.concat([sig, Buffer.from(comment, "utf8")]), pko, global)) {
    throw new Error("global signature (trusted comment) が一致しない");
  }
  return comment;
}

// tauri-plugin-updater の静的な更新情報 (pub_date は RFC 3339。notes は無ければ書かない)
// platforms: { <PLATFORMS のキー>: { signature, url } } (1 つ以上。キーは PLATFORMS の順に並べる)
export function latestJson({ version, platforms, pubDate, notes }) {
  if (!SEMVER.test(version)) throw new Error(`版が X.Y.Z の形でない: '${version}'`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(pubDate)) throw new Error(`pub_date が不正: ${pubDate}`);
  const keys = Object.keys(platforms ?? {});
  if (keys.length === 0) throw new Error("platforms が空");
  const out = { version };
  if (notes) out.notes = notes;
  out.pub_date = pubDate;
  out.platforms = {};
  for (const k of keys) {
    if (!PLATFORMS.includes(k)) throw new Error(`未知のプラットフォーム: ${k} (${PLATFORMS.join("|")})`);
  }
  for (const k of PLATFORMS.filter((p) => keys.includes(p))) {
    const { signature, url } = platforms[k];
    if (!signature) throw new Error(`${k} の signature が空`);
    if (new URL(url).protocol !== "https:") throw new Error(`url が https でない: ${url}`);
    out.platforms[k] = { signature, url };
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

export function rfc3339(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---- CLI ----------------------------------------------------------------------------------------

// --file / --url は "<プラットフォーム>=<値>" で、プラットフォームごとに 1 つずつ
function parseArgs(argv) {
  const opts = { file: {}, url: {} };
  const names = ["file", "url", "version", "pubkey-config", "out", "pub-date", "timestamp"];
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, "");
    const v = argv[i + 1];
    if (!names.includes(k) || v === undefined) throw new Error(`不明な引数: ${argv[i]}`);
    if (k === "file" || k === "url") {
      const eq = v.indexOf("=");
      const p = eq > 0 ? v.slice(0, eq) : "";
      if (!PLATFORMS.includes(p)) throw new Error(`--${k} は <${PLATFORMS.join("|")}>=<値> の形: ${v}`);
      if (opts[k][p] !== undefined) throw new Error(`--${k} ${p} が 2 回ある`);
      opts[k][p] = v.slice(eq + 1);
    } else {
      opts[k] = v;
    }
  }
  for (const k of ["version", "pubkey-config", "out"]) {
    if (!opts[k]) throw new Error(`--${k} が必要`);
  }
  const fp = Object.keys(opts.file);
  if (fp.length === 0) throw new Error("--file が必要");
  const up = Object.keys(opts.url);
  for (const p of new Set([...fp, ...up])) {
    if (!opts.file[p] || !opts.url[p]) throw new Error(`${p} の --file と --url は対で渡す`);
  }
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const keyB64 = process.env.TAURI_SIGNING_PRIVATE_KEY;
  if (!keyB64) throw new Error("TAURI_SIGNING_PRIVATE_KEY がない");
  // tauri signer と同じく、パスワードが無ければ空として扱う
  const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "";
  if (!SEMVER.test(opts.version)) throw new Error(`版が X.Y.Z の形でない: '${opts.version}'`);

  const pubkey = JSON.parse(readFileSync(opts["pubkey-config"], "utf8"))?.plugins?.updater?.pubkey;
  if (!pubkey) throw new Error(`${opts["pubkey-config"]} に plugins.updater.pubkey がない`);

  const key = decodeSecretKey(keyB64, password);
  const pub = decodePublicKey(pubkey);
  if (!pub.keynum.equals(key.keynum) || !pub.publicKey.equals(key.publicKey)) {
    throw new Error(`秘密鍵が ${opts["pubkey-config"]} の公開鍵と対でない (鍵 ID ${keyId(key.keynum)} / ${keyId(pub.keynum)})`);
  }

  const timestamp = opts.timestamp !== undefined ? Number(opts.timestamp) : Math.floor(Date.now() / 1000);
  const platforms = {};
  const sigs = [];
  const comments = {};
  for (const p of PLATFORMS.filter((x) => opts.file[x])) {
    const file = opts.file[p];
    const url = opts.url[p];
    const fileName = path.basename(file);
    if (path.basename(new URL(url).pathname) !== fileName) {
      throw new Error(`url のファイル名が ${fileName} でない: ${url}`);
    }
    const comment = trustedComment({ timestamp, fileName, version: opts.version });
    const prehash = await prehashFile(file);
    const signature = signPrehashed(prehash, key, comment);
    // 書く前に、アプリに入っている公開鍵で検証し直す
    if (verifySignature(signature, pubkey, prehash) !== comment) throw new Error("検証した trusted comment が違う");
    platforms[p] = { signature, url };
    sigs.push([path.join(opts.out, `${fileName}.sig`), signature]);
    comments[p] = comment;
  }
  if (new Set(sigs.map(([f]) => f)).size !== sigs.length) throw new Error("ファイル名が重複している");

  const pubDate = opts["pub-date"] ?? rfc3339(new Date(timestamp * 1000));
  const json = latestJson({ version: opts.version, platforms, pubDate });
  // すべて署名・検証できてから書く (途中で失敗したら何も書かない)
  for (const [f, sig] of sigs) writeFileSync(f, sig);
  writeFileSync(path.join(opts.out, "latest.json"), json);
  console.log(JSON.stringify({ keyId: keyId(key.keynum), trustedComments: comments, latest: path.join(opts.out, "latest.json") }));
}

// minisign の鍵 ID の表示 (keynum を u64 LE として16桁の16進数)
function keyId(keynum) {
  return keynum.readBigUInt64LE(0).toString(16).toUpperCase().padStart(16, "0");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`sign-updater: ${e.message}`);
    process.exit(1);
  });
}
