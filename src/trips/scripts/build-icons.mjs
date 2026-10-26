// Renders icon.svg (the source artwork) into the README, listing and manifest icons with Playwright's Chromium.
// Run `npm run build:icons` after changing icon.svg. Needs Chromium: `npx playwright install chromium`
// or PLAYWRIGHT_BROWSERS_PATH pointing at an existing install.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const root = new URL('../', import.meta.url);
const svg = readFileSync(new URL('icon.svg', root), 'utf8');

// `badge` keeps the transparent rounded corners. `bleed` fills the square for platforms that apply their own mask
// (iOS). `maskable` also shrinks the glyph into the central 80% circle that every launcher mask keeps.
const OUTPUTS = [
  ['icon.png', 1024, 'badge'],
  ['icon-128.png', 128, 'badge'],
  ['public/icons/icon-128.png', 128, 'badge'],
  ['public/icons/icon-192.png', 192, 'badge'],
  ['public/icons/icon-512.png', 512, 'badge'],
  ['public/icons/apple-touch-icon.png', 180, 'bleed'],
  ['public/icons/icon-maskable-512.png', 512, 'maskable'],
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const [file, size, variant] of OUTPUTS) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`);
    await page.evaluate(({ size, variant }) => {
      const icon = document.querySelector('svg');
      icon.setAttribute('width', size);
      icon.setAttribute('height', size);
      if (variant === 'badge') return;
      const badge = icon.getElementById('badge');
      for (const [name, value] of Object.entries({ x: 0, y: 0, width: 1024, height: 1024, rx: 0 })) badge.setAttribute(name, value);
      if (variant === 'maskable') icon.getElementById('glyph').setAttribute('transform', 'translate(512 512) scale(0.82) translate(-512 -512)');
    }, { size, variant });
    const target = new URL(file, root);
    mkdirSync(new URL('./', target), { recursive: true });
    writeFileSync(target, await page.locator('svg').screenshot({ omitBackground: true }));
    console.log(`${file} ${size}×${size}`);
  }
} finally {
  await browser.close();
}
