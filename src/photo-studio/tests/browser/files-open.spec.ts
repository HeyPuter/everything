// Opening files from the file picker or a drop: several files at once, and
// files whose extension does not match their contents.
import { expect, test } from '@playwright/test';
import { boot, idle } from './helpers';

async function png(page: import('@playwright/test').Page, color: string) {
  const bytes = await page.evaluate(async (color) => {
    const c = new OffscreenCanvas(20, 10);
    const g = c.getContext('2d')!;
    g.fillStyle = color;
    g.fillRect(0, 0, 20, 10);
    return Array.from(new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()));
  }, color);
  return Buffer.from(bytes);
}
const fileNames = (page: import('@playwright/test').Page) => page.evaluate(() => window.photoStudio.sessions.map((s) => s.fileName));

test('a damaged file does not stop the other files opened with it', async ({ page }) => {
  await boot(page);
  const good = await png(page, '#f00');
  await page.locator('#file-input').setInputFiles([
    { name: 'first.png', mimeType: 'image/png', buffer: good },
    { name: 'broken.png', mimeType: 'image/png', buffer: good.subarray(0, 40) },
    { name: 'third.png', mimeType: 'image/png', buffer: await png(page, '#00f') },
  ]);
  await expect.poll(() => fileNames(page)).toEqual(['first.png', 'third.png']);
  await idle(page);
  await expect(page.locator('#status')).toHaveText(/^broken\.png could not be opened: /);
});
