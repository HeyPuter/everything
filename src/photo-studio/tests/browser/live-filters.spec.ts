import { test, expect, type Page } from '@playwright/test';
import { boot, idle, run } from './helpers';

/** A 200 x 150 document whose only layer is 400 px wide: vertical stripes
 * every 20 px, with the right half of the layer off the canvas. */
async function openWideLayer(page: Page) {
  await page.evaluate(async () => {
    const c = new OffscreenCanvas(200, 150);
    c.getContext('2d')!.fillRect(0, 0, 1, 1);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const { openFile } = await import('/src/features/files/open.ts');
    await openFile(window.photoStudio, blob, 'wide.png');
    const e = window.photoStudio;
    const { gridFromImage } = await import('/src/model/tiles.ts');
    const { findLayer } = await import('/src/model/document.ts');
    const { setLayerPixels } = await import('/src/model/pixel-layer.ts');
    const w = 400, h = 150, data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const v = x % 20 < 6 ? 30 : 220;
        data.set([v, v, v, 255], (y * w + x) * 4);
      }
    const grid = gridFromImage(e.assets.tiles, { width: w, height: h, data });
    const id = e.layer!.id;
    e.command('Wide Layer', (d) => setLayerPixels(findLayer(d.layers, id)!, grid, d));
  });
  await idle(page);
}
/** Pixel of the selected layer's tiles, and of its Live Filter source. */
const pixels = (page: Page, x: number, y: number) =>
  page.evaluate(
    async ([x, y]) => {
      const e = window.photoStudio;
      const { readRGBA } = await import('/src/model/tiles.ts');
      const l = e.layer!;
      const at = (g: typeof l.pixels) => Array.from(readRGBA(e.assets.tiles, g!, { x, y, width: 1, height: 1 }).data);
      return { pixels: at(l.pixels), source: l.liveSource ? at(l.liveSource) : null };
    },
    [x, y] as const,
  );

test.beforeEach(async ({ page }) => {
  await boot(page);
});

test('Live Filters also filter the part of the layer outside the canvas', async ({ page }) => {
  await openWideLayer(page);
  await run(page, 'filter.convert-live');
  await run(page, 'filter.apply.box-blur', { params: { radius: 4 } });
  // Next to a stripe edge, on and off the canvas.
  for (const x of [107, 307]) {
    const p = await pixels(page, x, 75);
    expect(p.source).toEqual([220, 220, 220, 255]);
    expect(p.pixels[0]).toBeLessThan(200);
  }
});
