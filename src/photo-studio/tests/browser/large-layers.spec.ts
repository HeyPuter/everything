import { test, expect } from '@playwright/test';
import { boot, compositePixel, idle, openImage, type Backend } from './helpers';

for (const backend of ['default', 'WebGL'] as Backend[])
  test(`a pixel layer wider than the GPU texture limit still draws over the canvas (${backend})`, async ({ page }) => {
    await boot(page, backend);
    await openImage(page, 1000, 500, '#808080', 'gray.png');
    const limit = await page.evaluate(() => window.photoStudio.renderer.backend.maxSize);
    // A strip one tile wider than the limit, mostly off the canvas on both sides
    // (as a large layer scaled up with Free Transform leaves it).
    await page.evaluate(async (width) => {
      const e = window.photoStudio;
      const { gridFromImage } = await import('/src/model/tiles.ts');
      const { newPixelLayer } = await import('/src/model/pixel-layer.ts');
      const data = new Uint8ClampedArray(width * 20 * 4);
      for (let i = 0; i < data.length; i += 4) data.set([255, 0, 0, 255], i);
      const l = newPixelLayer('Wide', e.doc, gridFromImage(e.assets.tiles, { width, height: 20, data }, -4000, 100));
      e.command('Add wide', (d) => d.layers.push(l));
    }, limit + 256);
    await idle(page);
    await expect(page.locator('#status')).not.toContainText('GPU supports');
    expect(await compositePixel(page, 500, 110)).toEqual([255, 0, 0, 255]);
    expect(await compositePixel(page, 999, 119)).toEqual([255, 0, 0, 255]);
    expect(await compositePixel(page, 500, 130)).toEqual([128, 128, 128, 255]);
    // Moving it keeps drawing the part over the canvas.
    await page.evaluate(() => {
      const e = window.photoStudio;
      e.command('Move', (d) => {
        const l = d.layers.at(-1)!;
        l.pixels = { ...l.pixels!, x: l.pixels!.x + 100, y: l.pixels!.y + 100 };
        l.transform = { ...l.transform, x: l.transform.x + 100, y: l.transform.y + 100 };
      });
    });
    await idle(page);
    expect(await compositePixel(page, 0, 210)).toEqual([255, 0, 0, 255]);
    expect(await compositePixel(page, 500, 110)).toEqual([128, 128, 128, 255]);
  });
