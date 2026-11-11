/**
 * Downsample a master icon into the public/ size set used by everything apps.
 *
 *   npm i --no-save sharp
 *   node tools/render-icons.mjs [path-to-master.jpg|png]
 */
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const root = dirname(fileURLToPath(import.meta.url.replace(/tools\/render-icons\.mjs$/, 'x')));
const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(appRoot, 'public');
const masterArg = process.argv[2];
const masterPath =
  masterArg ||
  'C:/Users/matth/.cursor/projects/empty-window/assets/freecell-icon-master.jpg';

await mkdir(publicDir, { recursive: true });

const input = await readFile(masterPath);
const meta = await sharp(input).metadata();
const sq = Math.min(meta.width, meta.height);
const cropped = sharp(input).extract({
  left: Math.floor((meta.width - sq) / 2),
  top: Math.floor((meta.height - sq) / 2),
  width: sq,
  height: sq,
});

const masterPng = await cropped
  .clone()
  .resize(1024, 1024, { kernel: sharp.kernel.lanczos3 })
  .png({ effort: 9 })
  .toBuffer();

await writeFile(join(appRoot, 'icon.png'), masterPng);
console.log('wrote icon.png (1024)');

const sizes = [
  { size: 16, file: 'favicon-16x16.png', alsoRoot: false },
  { size: 32, file: 'favicon-32x32.png', alsoRoot: false },
  { size: 128, file: 'icon-128.png', alsoRoot: true },
  { size: 192, file: 'icon-192.png', alsoRoot: false },
  { size: 512, file: 'icon-512.png', alsoRoot: false },
];

for (const { size, file, alsoRoot } of sizes) {
  const buf = await sharp(masterPng)
    .resize(size, size, { kernel: sharp.kernel.lanczos3 })
    .png({ effort: 9 })
    .toBuffer();
  await writeFile(join(publicDir, file), buf);
  if (alsoRoot) await writeFile(join(appRoot, file), buf);
  console.log(`wrote public/${file}`);
}

const faviconSvg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <rect width="64" height="64" rx="14" fill="#1f6b4a"/>
  <rect x="8" y="10" width="10" height="14" rx="2" fill="none" stroke="#cfe8db" stroke-width="1.5"/>
  <rect x="21" y="10" width="10" height="14" rx="2" fill="none" stroke="#cfe8db" stroke-width="1.5"/>
  <rect x="34" y="10" width="10" height="14" rx="2" fill="none" stroke="#cfe8db" stroke-width="1.5"/>
  <rect x="47" y="10" width="10" height="14" rx="2" fill="none" stroke="#cfe8db" stroke-width="1.5"/>
  <rect x="18" y="28" width="28" height="28" rx="3" fill="#fcfcf8"/>
  <text x="32" y="42" text-anchor="middle" font-size="11" font-family="Georgia, serif" font-weight="700" fill="#1a1a1a">A</text>
  <text x="32" y="52" text-anchor="middle" font-size="12" fill="#1a1a1a">♣</text>
</svg>
`;
await writeFile(join(publicDir, 'favicon.svg'), faviconSvg);
await copyFile(join(publicDir, 'favicon.svg'), join(appRoot, 'public', 'favicon.svg')).catch(() => {});
console.log('wrote public/favicon.svg');
