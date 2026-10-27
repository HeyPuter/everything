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
  'C:/Users/matth/.cursor/projects/empty-window/assets/database-studio-icon-master.jpg';

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
const masterPng = await cropped.clone().resize(1024, 1024, { kernel: sharp.kernel.lanczos3 }).png({ effort: 9 }).toBuffer();
await writeFile(join(appRoot, 'icon.png'), masterPng);
for (const { size, file, alsoRoot } of [
  { size: 16, file: 'favicon-16x16.png' },
  { size: 32, file: 'favicon-32x32.png' },
  { size: 128, file: 'icon-128.png', alsoRoot: true },
  { size: 192, file: 'icon-192.png' },
  { size: 512, file: 'icon-512.png' },
]) {
  const buf = await sharp(masterPng).resize(size, size, { kernel: sharp.kernel.lanczos3 }).png({ effort: 9 }).toBuffer();
  await writeFile(join(publicDir, file), buf);
  if (alsoRoot) await writeFile(join(appRoot, file), buf);
}
await writeFile(
  join(publicDir, 'favicon.svg'),
  `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1a2a55"/><ellipse cx="32" cy="22" rx="16" ry="7" fill="#6ea8ff"/><path d="M16 22 v16 c0 4 7 7 16 7 s16-3 16-7 V22" fill="none" stroke="#6ea8ff" stroke-width="3"/></svg>`,
);
console.log('database-studio icons ready');
