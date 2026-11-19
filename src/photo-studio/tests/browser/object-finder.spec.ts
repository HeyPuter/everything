import { test, expect } from '@playwright/test';
import { boot, canvasClick, client, idle, openImage, tool } from './helpers';

// Highlight Objects: objects are found when the Object Selection tool is chosen,
// the one under the pointer is highlighted and a click selects it.

test('highlights the object under the pointer and selects it with a click', async ({ page }) => {
  await boot(page);
  await openImage(page, 300, 200, '#203040');
  // Two bright objects on the plain background.
  await page.evaluate(async () => {
    const e = window.photoStudio;
    const { readRGBA, writeRect } = await import('/src/model/tiles.ts');
    const { setLayerPixels } = await import('/src/model/pixel-layer.ts');
    e.command('Objects', (d) => {
      const l = d.layers[0];
      const img = readRGBA(e.assets.tiles, l.pixels!, { x: 0, y: 0, width: 300, height: 200 });
      for (let y = 0; y < 200; y++)
        for (let x = 0; x < 300; x++) {
          if (Math.hypot(x - 80, y - 100) < 40)
            img.data.set([250, 200, 40, 255], (y * 300 + x) * 4);
          if (x >= 180 && x < 250 && y >= 60 && y < 140)
            img.data.set([230, 60, 60, 255], (y * 300 + x) * 4);
        }
      setLayerPixels(l, writeRect(e.assets.tiles, l.pixels!, 0, 0, img), d);
    });
  });
  await idle(page);
  await tool(page, 'Object Selection Tool');
  await expect(page.locator('#object-finder')).toBeChecked();
  await expect(page.locator('#status')).toContainText(/objects? found/, { timeout: 60_000 });
  const highlight = page.locator('image.object-finder');
  const [x, y] = await client(page, 215, 100);
  await page.mouse.move(x, y);
  await page.mouse.move(x + 2, y + 1);
  await expect(highlight).toHaveCount(1);
  await expect.poll(async () => Number(await highlight.getAttribute('x'))).toBeGreaterThan(170);
  // Off the objects nothing is highlighted.
  const [ox, oy] = await client(page, 150, 20);
  await page.mouse.move(ox, oy);
  await expect(highlight).toHaveCount(0);
  await canvasClick(page, 215, 100);
  await idle(page);
  const sel = await page.evaluate(() => window.photoStudio.doc.selection);
  expect(sel!.x).toBeGreaterThanOrEqual(176);
  expect(sel!.x + sel!.width).toBeLessThanOrEqual(254);
  expect(sel!.width).toBeGreaterThan(60);
  // Show All Objects highlights every object.
  await page.locator('#object-show-all').click();
  await expect.poll(() => highlight.count()).toBeGreaterThanOrEqual(2);
  // Turning the finder off removes the highlights.
  await page.locator('#object-finder').uncheck();
  await expect(highlight).toHaveCount(0);
});
