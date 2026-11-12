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

test('a large SVG opens scaled to fit the document limits without distortion', async ({ page }) => {
  await boot(page);
  const svg = (w: number, h: number) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w / 2}" height="${h}" fill="#f00"/><rect x="${w / 2}" width="${w / 2}" height="${h}" fill="#00f"/></svg>`);
  await page.locator('#file-input').setInputFiles({ name: 'poster.svg', mimeType: 'image/svg+xml', buffer: svg(20000, 10000) });
  await expect.poll(() => fileNames(page)).toEqual(['poster.svg']);
  await idle(page);
  // 24 megapixels at 2:1.
  expect(await page.evaluate(() => [window.photoStudio.doc.width, window.photoStudio.doc.height])).toEqual([6928, 3464]);
  await page.locator('#file-input').setInputFiles({ name: 'banner.svg', mimeType: 'image/svg+xml', buffer: svg(16000, 2000) });
  await expect.poll(() => fileNames(page)).toHaveLength(2);
  await idle(page);
  expect(await page.evaluate(() => [window.photoStudio.doc.width, window.photoStudio.doc.height])).toEqual([8192, 1024]);
});

test('files dropped while a task runs open when it finishes', async ({ page }) => {
  await boot(page);
  const bytes = Array.from(await png(page, '#0a0'));
  // A task that holds the editor until the test lets it finish.
  await page.evaluate(() => void window.photoStudio.run(() => new Promise<void>((r) => ((window as unknown as { finish: () => void }).finish = r))));
  await page.evaluate((bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'dropped.png', { type: 'image/png' }));
    document.querySelector('.workspace')!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, bytes);
  await expect(page.locator('#status')).toHaveText('dropped.png opens when the current task finishes.');
  expect(await fileNames(page)).toEqual([undefined]);
  await page.evaluate(() => (window as unknown as { finish: () => void }).finish());
  await expect.poll(() => fileNames(page)).toEqual(['dropped.png']);
  await idle(page);
  await expect(page.locator('#status')).toHaveText('Opened dropped.png');
});
