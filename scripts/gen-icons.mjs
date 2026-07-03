// One-off asset generator: renders iOS/Android icon variants from public/icon.svg
// via headless Chromium (playwright-core, installed with --no-save).
// Usage: node scripts/gen-icons.mjs
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync(new URL('../public/icon.svg', import.meta.url), 'utf8');

// Artwork = everything inside <svg> except the rounded-rect background.
const artwork = src
  .replace(/^[\s\S]*?<rect[^>]*\/>/, '')
  .replace(/<\/svg>\s*$/, '');

// iOS applies its own corner mask and renders transparency as black, so the
// apple-touch-icon needs a square, fully opaque background.
const squareSvg = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#FDFBF7"/>${inner}</svg>`;

const appleTouch = squareSvg(artwork);
// Maskable: artwork scaled to 80% so it stays inside the adaptive-icon safe zone.
const maskable = squareSvg(`<g transform="translate(51.2 51.2) scale(0.8)">${artwork}</g>`);

const targets = [
  { name: 'apple-touch-icon.png', svg: appleTouch, size: 180 },
  { name: 'icon-maskable-512.png', svg: maskable, size: 512 },
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
for (const { name, svg, size } of targets) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`
  );
  const buf = await page.screenshot({ clip: { x: 0, y: 0, width: size, height: size } });
  writeFileSync(new URL(`../public/${name}`, import.meta.url), buf);
  console.log(`wrote public/${name} (${buf.length} bytes)`);
}
await browser.close();
