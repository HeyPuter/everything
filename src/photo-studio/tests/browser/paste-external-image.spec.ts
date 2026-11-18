// After copying in the workspace, an image copied in another app (while the
// page was not focused) is what Paste pastes; the workspace's own copy is
// pasted again while the system clipboard still holds it.
import { test, expect, type Page } from '@playwright/test';
import { boot, idle, openImage, run } from './helpers';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const topLayer = (page: Page) =>
  page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA, gridDocBounds } = await import('/src/model/tiles.ts');
    const l = e.doc.layers.at(-1)!;
    const b = gridDocBounds(l.pixels!)!;
    const px = readRGBA(e.assets.tiles, l.pixels!, { x: b.x, y: b.y, width: 1, height: 1 }).data;
    return {
      count: e.doc.layers.length,
      width: b.width,
      height: b.height,
      rgb: [px[0], px[1], px[2]],
    };
  });

test('Paste takes an image copied elsewhere over the workspace copy', async ({ page }) => {
  await boot(page);
  await openImage(page, 40, 30, '#ff0000');
  await run(page, 'select.all');
  await run(page, 'edit.copy');
  // The own copy reached the system clipboard; leaving and coming back
  // without copying anything else still pastes it.
  await expect
    .poll(() => page.evaluate(async () => (await navigator.clipboard.read()).length))
    .toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await run(page, 'edit.paste');
  expect(await topLayer(page)).toEqual({ count: 2, width: 40, height: 30, rgb: [255, 0, 0] });
  // Another app copies a blue 12 × 8 image while the page is in the background.
  await page.evaluate(async () => {
    window.dispatchEvent(new Event('blur'));
    const canvas = new OffscreenCanvas(12, 8);
    const c = canvas.getContext('2d')!;
    c.fillStyle = '#0000ff';
    c.fillRect(0, 0, 12, 8);
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': await canvas.convertToBlob({ type: 'image/png' }) }),
    ]);
  });
  await run(page, 'edit.paste');
  await idle(page);
  expect(await topLayer(page)).toEqual({ count: 3, width: 12, height: 8, rgb: [0, 0, 255] });
});

test('Paste keeps the workspace copy when it never reached the system clipboard', async ({
  page,
}) => {
  await boot(page);
  // An older image from another app is on the system clipboard.
  await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(12, 8);
    const c = canvas.getContext('2d')!;
    c.fillStyle = '#0000ff';
    c.fillRect(0, 0, 12, 8);
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': await canvas.convertToBlob({ type: 'image/png' }) }),
    ]);
  });
  await openImage(page, 40, 30, '#ff0000');
  // The browser refuses the workspace's write (as without permission or
  // outside a user gesture), so the system clipboard keeps the older image.
  await page.evaluate(() => {
    navigator.clipboard.write = () => Promise.reject(new DOMException('Denied', 'NotAllowedError'));
  });
  await run(page, 'select.all');
  await run(page, 'edit.copy');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await run(page, 'edit.paste');
  await idle(page);
  expect(await topLayer(page)).toEqual({ count: 2, width: 40, height: 30, rgb: [255, 0, 0] });
});
