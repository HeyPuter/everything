import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = require('sharp');
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
await mkdir(publicDir, { recursive: true });

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#3b6dff"/>
      <stop offset="100%" stop-color="#1e3fb8"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect width="1024" height="1024" rx="230" fill="url(#bg)"/>
  <rect x="210" y="180" width="600" height="680" rx="48" fill="#f7f9ff" filter="url(#shadow)"/>
  <rect x="260" y="250" width="500" height="36" rx="10" fill="#d9e2ff"/>
  <rect x="260" y="320" width="420" height="28" rx="8" fill="#2f5bff"/>
  <rect x="260" y="380" width="360" height="28" rx="8" fill="#93a9ff"/>
  <rect x="260" y="440" width="480" height="28" rx="8" fill="#c5d0ff"/>
  <text x="512" y="720" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="120" font-weight="700" fill="#1e3fb8">VBA</text>
</svg>`;

await writeFile(join(publicDir, 'favicon.svg'), svg);
const master = await sharp(Buffer.from(svg)).png().toBuffer();
await writeFile(join(root, 'icon.png'), await sharp(master).resize(1024, 1024).png().toBuffer());
for (const size of [16, 32, 128, 192, 512]) {
  const buf = await sharp(master).resize(size, size).png().toBuffer();
  const name = size <= 32 ? `favicon-${size}x${size}.png` : `icon-${size}.png`;
  await writeFile(join(publicDir, name), buf);
  if (size === 128) await writeFile(join(root, 'icon-128.png'), buf);
}
console.log('vba-studio icons ready');
