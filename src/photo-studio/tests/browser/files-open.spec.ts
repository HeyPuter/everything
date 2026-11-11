// Opening files from the file picker or a drop: several files at once, and
// files whose extension does not match their contents.
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
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

test('PSD files and projects open by their contents whatever their extension', async ({ page }) => {
  await boot(page);
  const psd = readFileSync('tests/fixtures/layer-order.psd');
  await page.locator('#file-input').setInputFiles({ name: 'downloaded.png', mimeType: 'image/png', buffer: psd });
  await expect.poll(() => fileNames(page)).toEqual(['downloaded.png']);
  await idle(page);
  await expect(page.locator('#status')).toContainText('PSD opened');
  expect(await page.evaluate(() => [window.photoStudio.doc.name, window.photoStudio.doc.layers.length > 1])).toEqual(['downloaded', true]);
  // A project saved under another name opens as a project.
  const project = await page.evaluate(async () => {
    const { serialize } = await import('/src/model/serialization.ts');
    const e = window.photoStudio;
    return Array.from(new Uint8Array(await (await serialize(e.doc, e.assets)).arrayBuffer()));
  });
  await page.locator('#file-input').setInputFiles({ name: 'project-copy.bin', mimeType: 'application/octet-stream', buffer: Buffer.from(project) });
  await expect.poll(() => fileNames(page)).toEqual(['downloaded.png', 'project-copy.bin']);
  await idle(page);
  await expect(page.locator('#status')).toHaveText('Project opened');
  // A file named .psd that holds a PNG opens as the image it is.
  await page.locator('#file-input').setInputFiles({ name: 'renamed.psd', mimeType: '', buffer: await png(page, '#0f0') });
  await expect.poll(() => fileNames(page)).toHaveLength(3);
  await idle(page);
  await expect(page.locator('#status')).toHaveText('Opened renamed.psd');
});
