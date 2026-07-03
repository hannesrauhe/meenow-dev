// One-off asset generator: renders the social-share preview card (Open Graph /
// Twitter image, 1200x630) from public/icon.svg via headless Chromium
// (playwright-core, installed with --no-save). Usage: node scripts/gen-og-image.mjs
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/icon.svg', import.meta.url), 'utf8');

// Artwork = everything inside <svg> except the rounded-rect background.
const artwork = src
  .replace(/^[\s\S]*?<rect[^>]*\/>/, '')
  .replace(/<\/svg>\s*$/, '');

const W = 1200;
const H = 630;

// Brand palette mirrors index.html / manifest: cream #FDFBF7, gold #C9A96E, ink #1C1A17.
const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0}
  .card{
    width:${W}px;height:${H}px;box-sizing:border-box;
    background:#FDFBF7;
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    position:relative;
  }
  .card::after{content:"";position:absolute;inset:24px;border:3px solid #C9A96E;border-radius:32px}
  .logo{width:200px;height:200px}
  .wordmark{margin-top:28px;font-size:104px;font-weight:800;letter-spacing:-2px;color:#1C1A17;line-height:1}
  .tagline{margin-top:20px;font-size:36px;font-weight:500;color:#6B6456}
</style></head>
<body>
  <div class="card">
    <svg class="logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${artwork}</svg>
    <div class="wordmark">meenow</div>
    <div class="tagline">One spontaneous photo a day, shared with friends</div>
  </div>
</body></html>`;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ deviceScaleFactor: 1 });
await page.setViewportSize({ width: W, height: H });
await page.setContent(html);
const buf = await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } });
writeFileSync(new URL('../public/og-image.png', import.meta.url), buf);
console.log(`wrote public/og-image.png (${buf.length} bytes)`);
await browser.close();
