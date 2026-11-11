import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const masterPath = process.argv[2];
const outRoot = process.argv[3];
if (!masterPath || !outRoot) {
  console.error('Usage: node render-from-master.mjs <master> <outRoot>');
  process.exit(1);
}

await mkdir(join(outRoot, 'public'), { recursive: true });
const input = await readFile(masterPath);
const meta = await sharp(input).metadata();
const sq = Math.min(meta.width, meta.height);
const big = await sharp(input)
  .extract({
    left: Math.floor((meta.width - sq) / 2),
    top: Math.floor((meta.height - sq) / 2),
    width: sq,
    height: sq,
  })
  .resize(1024, 1024, { kernel: sharp.kernel.lanczos3 })
  .png({ effort: 9 })
  .toBuffer();

await writeFile(join(outRoot, 'icon.png'), big);
for (const size of [16, 32, 128, 192, 512]) {
  const buf = await sharp(big)
    .resize(size, size, { kernel: sharp.kernel.lanczos3 })
    .png({ effort: 9 })
    .toBuffer();
  const name = size <= 32 ? `favicon-${size}x${size}.png` : `icon-${size}.png`;
  await writeFile(join(outRoot, 'public', name), buf);
  if (size === 128) await writeFile(join(outRoot, 'icon-128.png'), buf);
}
console.log('ok', outRoot);
