/**
 * Downsample paint-icon-master into the public/ size set.
 *   npm i --no-save sharp && node tools/render-icons.mjs [master]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(appRoot, 'public');
const masterPath =
  process.argv[2] ||
  'C:/Users/matth/.cursor/projects/empty-window/assets/paint-icon-master.jpg';

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
  <rect width="64" height="64" rx="14" fill="#2a6fb0"/>
  <rect x="14" y="14" width="36" height="28" rx="3" fill="#fcfcf8"/>
  <path d="M22 48 L30 34 L36 40 L42 28" stroke="#1a1a1a" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="46" cy="46" r="6" fill="#e85d4c"/>
</svg>
`;
await writeFile(join(publicDir, 'favicon.svg'), faviconSvg);
console.log('wrote public/favicon.svg');
