// LP の OG 画像 (1200x630 の JPG) を作る。HTML を組んで Playwright の Chromium で撮る。
// 使い方 (apps/web で): node scripts/og-image.mjs en
//   → public/og-image-en.jpg と assets/brand/web/og-image-en.jpg に書き出す
// 構成は日本語版 (public/og-image.jpg) と同じ: 左にロゴのキャラクター、右に名前・説明・特長 3 行。
// 日本語版はこのスクリプトより前に作ったもの。ja を指定すると同じ構成で作り直せるが、既存の画像と画素単位では一致しない
import { copyFileSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { AudioLines, Cpu, Keyboard } from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(WEB, "../..");

const TEXT = {
  ja: {
    lang: "ja",
    tagline: "Mac に常駐する音声入力アプリ",
    features: ["端末内で文字起こし", "話した部分だけを自動で入力", "キー操作も声で"],
    out: "og-image.jpg",
  },
  en: {
    lang: "en",
    tagline: "Voice input that stays running on your Mac",
    features: ["On-device transcription", "Types only what you say", "Key presses by voice"],
    out: "og-image-en.jpg",
  },
};

const locale = process.argv[2];
const t = TEXT[locale];
if (!t) {
  console.error(`使い方: node scripts/og-image.mjs <${Object.keys(TEXT).join("|")}>`);
  process.exit(1);
}

const icon = (C) =>
  renderToStaticMarkup(createElement(C, { size: 23, strokeWidth: 2, color: "#3b5bdb" }));
const ICONS = [Cpu, AudioLines, Keyboard];

// フォントは LP と同じ IBM Plex Sans (同梱の @fontsource)。和文は IBM Plex Sans JP
const fontCss = (pkg, weight) =>
  pathToFileURL(join(WEB, "node_modules/@fontsource", pkg, `${weight}.css`)).href;
const logo = pathToFileURL(join(ROOT, "assets/brand/logo/mukuchi-logo_1024.png")).href;

const html = `<!doctype html>
<html lang="${t.lang}"><head><meta charset="utf-8">
${["ibm-plex-sans", "ibm-plex-sans-jp"]
  .flatMap((p) => [400, 500, 600].map((w) => `<link rel="stylesheet" href="${fontCss(p, w)}">`))
  .join("\n")}
<style>
  html, body { margin: 0; }
  body {
    width: 1200px; height: 630px; background: #fff; color: #14171d;
    font-family: "IBM Plex Sans", "IBM Plex Sans JP", sans-serif;
    display: grid; grid-template-columns: 572px 540px; align-items: center;
  }
  .logo { justify-self: center; width: 330px; margin-left: -6px; }
  h1 { margin: 0; font-size: 92px; font-weight: 600; line-height: 1; letter-spacing: -0.5px; }
  .tagline { margin: 20px 0 0; font-size: 26px; font-weight: 400; color: #4d5666; }
  hr { margin: 30px 0 32px; border: 0; border-top: 2px solid #eceff4; }
  ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 18px; }
  li { display: flex; align-items: center; gap: 14px; font-size: 25px; font-weight: 500; }
  li svg { flex: none; }
</style></head>
<body>
  <img class="logo" src="${logo}" alt="">
  <div>
    <h1>mukuchi</h1>
    <p class="tagline">${t.tagline}</p>
    <hr>
    <ul>${t.features.map((f, i) => `<li>${icon(ICONS[i])}<span>${f}</span></li>`).join("")}</ul>
  </div>
</body></html>`;

// file:// のページからフォント・画像 (同じく file://) を読めるよう、HTML も一時ファイルに置いて開く
const dir = mkdtempSync(join(tmpdir(), "mukuchi-og-"));
const page = join(dir, "og.html");
writeFileSync(page, html);

const browser = await chromium.launch();
try {
  const p = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await p.goto(pathToFileURL(page).href);
  await p.evaluate(() => document.fonts.ready);
  const out = join(WEB, "public", t.out);
  writeFileSync(out, await p.screenshot({ type: "jpeg", quality: 90 }));
  copyFileSync(out, join(ROOT, "assets/brand/web", t.out));
  console.log(`${out} (${readFileSync(out).length} B)`);
} finally {
  await browser.close();
}
