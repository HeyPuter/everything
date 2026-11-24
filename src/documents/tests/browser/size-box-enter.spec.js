import { test, expect } from '@playwright/test';
import { deflateSync } from 'node:zlib';
import { onTab } from './helpers/editor-tools.js';

// A PNG of `width`×`height` red pixels (independently written bytes).
const png = (width, height) => {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = bytes => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8); out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length); return out; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from([255, 0, 0]))])));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
};

// Enter in a ribbon size box applies the amount once: the browser's own change event for the same amount
// no longer applies it again (a refused size was reported twice, an accepted one written twice).
test('Enter in a picture size box applies the size once', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/playground.html');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('textbox', { name: 'Document text' }).fill('Banner: ');
  await onTab(page, 'insert');
  // 600 × 20 pixels: kept in proportion, 1 in tall would make it 30 in wide.
  await page.getByLabel('Insert picture file').setInputFiles({ name: 'banner.png', mimeType: 'image/png', buffer: png(600, 20) });
  const height = page.getByRole('spinbutton', { name: 'Picture height (in)' });
  await height.fill('1'); await height.press('Enter');
  await expect(page.locator('.toast', { hasText: 'Sizes must be at most 22 inches.' })).toHaveCount(1);
  await height.press('Tab');
  await page.waitForTimeout(300);
  await expect(page.locator('.toast', { hasText: 'Sizes must be at most 22 inches.' })).toHaveCount(1);
});
